#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:-builder.itsmechinna.com}"
SNIPPET="/etc/nginx/snippets/chinna-webcontainer-isolation.conf"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SITE_FILE_LINK="$({
  grep -RIlE "server_name[^;]*${DOMAIN//./\\.}" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true
} | head -n 1)"

if [[ -z "$SITE_FILE_LINK" ]]; then
  echo "Could not find an Nginx server block for ${DOMAIN}." >&2
  exit 1
fi

SITE_FILE="$(readlink -f "$SITE_FILE_LINK")"

if [[ -z "$SITE_FILE" || ! -f "$SITE_FILE" ]]; then
  echo "Could not resolve the Nginx configuration file: ${SITE_FILE_LINK}." >&2
  exit 1
fi

mkdir -p /etc/nginx/snippets
cat > "$SNIPPET" <<'EOF'
proxy_hide_header Cross-Origin-Opener-Policy;
proxy_hide_header Cross-Origin-Embedder-Policy;
proxy_hide_header Cross-Origin-Resource-Policy;

add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "credentialless" always;
add_header Cross-Origin-Resource-Policy "cross-origin" always;
EOF

BACKUP="${SITE_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$SITE_FILE" "$BACKUP"

python3 - "$SITE_FILE" "$DOMAIN" "$SNIPPET" <<'PY'
from pathlib import Path
import re
import sys

site_path = Path(sys.argv[1])
domain = sys.argv[2]
snippet = sys.argv[3]
text = site_path.read_text()


def block_end(source: str, open_brace: int) -> int | None:
    depth = 0
    for index in range(open_brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    return None


def strip_cross_origin_directives(block: str) -> str:
    patterns = [
        rf"^\s*include\s+{re.escape(snippet)}\s*;\s*$",
        r"^\s*proxy_hide_header\s+Cross-Origin-(?:Opener|Embedder|Resource)-Policy\s*;\s*$",
        r"^\s*add_header\s+Cross-Origin-(?:Opener|Embedder|Resource)-Policy\b[^;]*;\s*$",
    ]
    for pattern in patterns:
        block = re.sub(pattern, "", block, flags=re.I | re.M)
    block = re.sub(r"\n{3,}", "\n\n", block)
    return block

server_match = None
for match in re.finditer(r"server\s*\{", text, flags=re.M):
    brace = text.find("{", match.start())
    end = block_end(text, brace)
    if end is None:
        continue
    candidate = text[match.start():end]
    if re.search(rf"server_name\s+[^;]*\b{re.escape(domain)}\b[^;]*;", candidate):
        server_match = (match.start(), end, candidate)
        break

if server_match is None:
    print(f"No matching server block for {domain} in {site_path}", file=sys.stderr)
    raise SystemExit(1)

server_start, server_end, server_block = server_match
server_block = strip_cross_origin_directives(server_block)

location_ranges: list[tuple[int, int]] = []
for match in re.finditer(r"location(?:\s+[^\{]+)?\s*\{", server_block, flags=re.M):
    brace = server_block.find("{", match.start())
    end = block_end(server_block, brace)
    if end is None:
        continue
    location_block = server_block[match.start():end]
    if re.search(r"\bproxy_pass\b", location_block):
        location_ranges.append((match.start(), end))

include_line = f"    include {snippet};"

if location_ranges:
    for start, end in reversed(location_ranges):
        location_block = strip_cross_origin_directives(server_block[start:end])
        brace = location_block.find("{")
        location_block = location_block[: brace + 1] + "\n" + include_line + location_block[brace + 1 :]
        server_block = server_block[:start] + location_block + server_block[end:]
else:
    server_name = re.search(r"server_name\s+[^;]*;", server_block)
    if not server_name:
        print(f"No server_name directive found for {domain}", file=sys.stderr)
        raise SystemExit(1)
    insert_at = server_name.end()
    server_block = server_block[:insert_at] + "\n" + include_line + server_block[insert_at:]

text = text[:server_start] + server_block + text[server_end:]
site_path.write_text(text)
print(f"Normalised WebContainer headers in {site_path}")
PY

if ! nginx -t; then
  cp -a "$BACKUP" "$SITE_FILE"
  nginx -t || true
  echo "Nginx validation failed. Restored ${BACKUP}." >&2
  exit 1
fi

systemctl reload nginx

for _ in $(seq 1 30); do
  if curl -fsS "https://${DOMAIN}/" >/dev/null; then
    break
  fi
  sleep 2
done

HEADERS="$(curl -fsSI "https://${DOMAIN}/" | tr -d '\r')"
printf '%s\n' "$HEADERS" | grep -Ei '^(HTTP/|cross-origin-(opener|embedder|resource)-policy:)' || true

coop_count="$(printf '%s\n' "$HEADERS" | grep -Eic '^Cross-Origin-Opener-Policy:[[:space:]]*same-origin[[:space:]]*$' || true)"
coep_count="$(printf '%s\n' "$HEADERS" | grep -Eic '^Cross-Origin-Embedder-Policy:[[:space:]]*credentialless[[:space:]]*$' || true)"
corp_count="$(printf '%s\n' "$HEADERS" | grep -Eic '^Cross-Origin-Resource-Policy:[[:space:]]*cross-origin[[:space:]]*$' || true)"
conflict_count="$(printf '%s\n' "$HEADERS" | grep -Eic '^Cross-Origin-Embedder-Policy:[[:space:]]*require-corp[[:space:]]*$' || true)"

if [[ "$coop_count" -ne 1 || "$coep_count" -ne 1 || "$corp_count" -ne 1 || "$conflict_count" -ne 0 ]]; then
  echo "Cross-origin header validation failed." >&2
  echo "Expected exactly one same-origin, credentialless, and cross-origin header, with no require-corp value." >&2
  echo "Backup: ${BACKUP}" >&2
  exit 1
fi

echo "WebContainer cross-origin headers are canonical and conflict-free."
echo "Backup: ${BACKUP}"

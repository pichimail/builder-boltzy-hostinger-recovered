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
    return re.sub(r"\n{3,}", "\n\n", block)


def matching_server_blocks(source: str) -> list[tuple[int, int, str]]:
    blocks: list[tuple[int, int, str]] = []
    for match in re.finditer(r"server\s*\{", source, flags=re.M):
        brace = source.find("{", match.start())
        end = block_end(source, brace)
        if end is None:
            continue
        block = source[match.start():end]
        if re.search(rf"server_name\s+[^;]*\b{re.escape(domain)}\b[^;]*;", block):
            blocks.append((match.start(), end, block))
    return blocks


def add_snippet_to_proxy_locations(server_block: str) -> tuple[str, int]:
    locations: list[tuple[int, int, str]] = []

    for match in re.finditer(r"location(?:\s+[^\{]+)?\s*\{", server_block, flags=re.M):
        brace = server_block.find("{", match.start())
        end = block_end(server_block, brace)
        if end is None:
            continue

        location_block = server_block[match.start():end]
        if not re.search(r"\bproxy_pass\b", location_block):
            continue

        line_start = server_block.rfind("\n", 0, match.start()) + 1
        indent = server_block[line_start:match.start()]
        locations.append((match.start(), end, indent))

    for start, end, indent in reversed(locations):
        location_block = strip_cross_origin_directives(server_block[start:end])
        brace = location_block.find("{")
        include_line = f"\n{indent}    include {snippet};"
        location_block = location_block[: brace + 1] + include_line + location_block[brace + 1 :]
        server_block = server_block[:start] + location_block + server_block[end:]

    return server_block, len(locations)


servers = matching_server_blocks(text)
if not servers:
    print(f"No matching server block for {domain} in {site_path}", file=sys.stderr)
    raise SystemExit(1)

# Prefer the actual reverse-proxy server. This avoids editing the first matching
# block when it is only the port-80 redirect server.
selected_index = next((index for index, (_, _, block) in enumerate(servers) if re.search(r"\bproxy_pass\b", block)), None)
if selected_index is None:
    selected_index = next(
        (
            index
            for index, (_, _, block) in enumerate(servers)
            if re.search(r"\blisten\s+[^;]*(?:443|ssl)\b", block)
        ),
        None,
    )

if selected_index is None:
    print(f"Could not find an HTTPS/proxy server block for {domain}", file=sys.stderr)
    raise SystemExit(1)

replacements: list[tuple[int, int, str]] = []
proxy_location_count = 0

for index, (start, end, block) in enumerate(servers):
    cleaned = strip_cross_origin_directives(block)

    if index == selected_index:
        cleaned, proxy_location_count = add_snippet_to_proxy_locations(cleaned)
        if proxy_location_count == 0:
            server_name = re.search(r"server_name\s+[^;]*;", cleaned)
            if not server_name:
                print(f"No server_name directive found for {domain}", file=sys.stderr)
                raise SystemExit(1)
            cleaned = cleaned[: server_name.end()] + f"\n    include {snippet};" + cleaned[server_name.end() :]

    replacements.append((start, end, cleaned))

for start, end, replacement in reversed(replacements):
    text = text[:start] + replacement + text[end:]

site_path.write_text(text)
print(
    f"Normalised WebContainer headers in {site_path}; "
    f"targeted proxy locations: {proxy_location_count}"
)
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

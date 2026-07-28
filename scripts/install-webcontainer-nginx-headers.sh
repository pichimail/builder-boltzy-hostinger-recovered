#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:-builder.itsmechinna.com}"
SNIPPET="/etc/nginx/snippets/chinna-webcontainer-isolation.conf"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SITE_FILE="$({
  grep -RIlE "server_name[^;]*${DOMAIN//./\\.}" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true
} | head -n 1)"

if [[ -z "$SITE_FILE" ]]; then
  echo "Could not find an Nginx server block for ${DOMAIN}." >&2
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
include_line = f"    include {snippet};"

if include_line in text:
    print(f"Header snippet is already included in {site_path}")
    raise SystemExit(0)

server_pattern = re.compile(r"server\s*\{", re.M)
for match in server_pattern.finditer(text):
    start = match.start()
    brace = text.find("{", start)
    depth = 0
    end = None
    for index in range(brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end is None:
        continue
    block = text[start:end]
    if re.search(rf"server_name\s+[^;]*\b{re.escape(domain)}\b[^;]*;", block):
        server_name = re.search(r"server_name\s+[^;]*;", block)
        if not server_name:
            continue
        insert_at = start + server_name.end()
        text = text[:insert_at] + "\n" + include_line + text[insert_at:]
        site_path.write_text(text)
        print(f"Installed WebContainer headers in {site_path}")
        raise SystemExit(0)

print(f"No matching server block for {domain} in {site_path}", file=sys.stderr)
raise SystemExit(1)
PY

if ! nginx -t; then
  cp -a "$BACKUP" "$SITE_FILE"
  nginx -t || true
  echo "Nginx validation failed. Restored ${BACKUP}." >&2
  exit 1
fi

systemctl reload nginx

echo
echo "Response headers for https://${DOMAIN}/:"
curl -fsSI "https://${DOMAIN}/" \
  | tr -d '\r' \
  | grep -Ei '^(HTTP/|cross-origin-(opener|embedder|resource)-policy:)' || true

echo
echo "Expected:"
echo "  Cross-Origin-Opener-Policy: same-origin"
echo "  Cross-Origin-Embedder-Policy: credentialless"
echo "Backup: ${BACKUP}"

"""Package only the plugin's runtime files; no repository or temp data."""
import pathlib
import json
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parent
target = pathlib.Path(sys.argv[1]).resolve()
manifest = json.loads((root / "manifest.json").read_text())
settings = manifest.get("applications", {}).get("zotero", {})
for field in ("id", "update_url", "strict_max_version"):
    if not settings.get(field):
        raise ValueError(f"Zotero requires applications.zotero.{field}")
if manifest["version"] != json.loads((root / "package.json").read_text())["version"]:
    raise ValueError("Manifest and package versions must agree")
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in ("manifest.json", "bootstrap.js", "page-tools.js", "README.md"):
        archive.write(root / name, name)
print(target)

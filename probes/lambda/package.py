import argparse
import hashlib
import json
import stat
import struct
import zipfile
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package(host, fixtures, output):
    binary = host.read_bytes()
    if binary[:6] != b"\x7fELF\x02\x01" or len(binary) < 64:
        raise ValueError("host is not a 64-bit little-endian ELF; build the Amazon Linux host")
    if struct.unpack_from("<H", binary, 18)[0] != 62:
        raise ValueError("host is not x86_64; use the verified build target")
    output.mkdir()
    bootstrap = (Path(__file__).parent / "bootstrap").read_bytes()
    packages = []
    for route, artifact in fixtures.items():
        component = Path(artifact["component"]).read_bytes()
        if digest(component) != artifact["sha256"] or len(component) != artifact["bytes"]:
            raise ValueError(f"component changed: {route}; rebuild and verify the fixtures")
        route_id = route.rsplit("/route.", 1)[0].replace("/", "-")
        if not route_id or any(c not in "abcdefghijklmnopqrstuvwxyz-" for c in route_id):
            raise ValueError(f"invalid route name: {route}; use a known fixture")
        modes = [False, True] if route in ["counter/route.rs", "go/counter/route.go", "python/response/route.py"] else [False]
        configurations = [(mode, allow) for mode in modes for allow in ([False, True] if "outbound/" in route else [False])]
        for per_request, allow in configurations:
            name = route_id + ("-per-request" if per_request else "-reuse") + ("-outbound" if allow else "")
            manifest = {"component": "route.cwasm", "perRequest": per_request, "requestsPerInstance": 1000 if route.startswith("go/") else 0}
            if allow:
                manifest["outboundAllow"] = ["127.0.0.1"]
            files = {
                "bootstrap": (bootstrap, 0o755),
                "polyroute-lambda": (binary, 0o755),
                "route.cwasm": (component, 0o644),
                "manifest.json": ((json.dumps(manifest, indent=2) + "\n").encode(), 0o644),
            }
            archive = output / f"{name}.zip"
            with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
                for filename, (data, mode) in files.items():
                    info = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | mode) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    target.writestr(info, data)
            extracted = output / name
            extracted.mkdir()
            with zipfile.ZipFile(archive) as source:
                if sorted(source.namelist()) != sorted(files):
                    raise ValueError("archive file set changed; inspect the package builder")
                for filename, (expected, mode) in files.items():
                    data = source.read(filename)
                    if digest(data) != digest(expected) or (source.getinfo(filename).external_attr >> 16) != stat.S_IFREG | mode:
                        raise ValueError(f"archive mismatch: {filename}; inspect the package builder")
                    destination = extracted / filename
                    with destination.open("xb") as stream:
                        stream.write(data)
                    destination.chmod(mode)
            packages.append({"name": name, "route": route, "perRequest": per_request, "outboundAllow": manifest.get("outboundAllow", []), "archive": archive.name, "directory": name, "sha256": digest(archive.read_bytes()), "files": {key: {"bytes": len(data), "sha256": digest(data), "mode": mode} for key, (data, mode) in files.items()}})
    (output / "packages.json").write_text(json.dumps(packages, indent=2) + "\n")
    return packages


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    packages = package(args.host, json.loads(args.fixtures.read_text()), args.output)
    print(f"Verified {len(packages)} extracted function archives.")

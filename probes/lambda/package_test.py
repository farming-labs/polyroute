import hashlib
import importlib.util
import json
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("packager", Path(__file__).with_name("package.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="polyroute-lambda-package-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.host = self.root / "host"
        self.component = self.root / "component"
        self.component.write_bytes(b"fixture component")
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", header, 18, 62)
        self.host.write_bytes(header)
        self.fixtures = {"go/counter/route.go": {"component": str(self.component), "bytes": self.component.stat().st_size, "sha256": hashlib.sha256(self.component.read_bytes()).hexdigest()}}

    def test_archive_preserves_modes_bytes_relative_manifest_and_go_limit(self):
        packages = packager.package(self.host, self.fixtures, self.root / "output with spaces")
        self.assertEqual(len(packages), 2)
        for item in packages:
            extracted = self.root / "output with spaces" / item["directory"]
            self.assertEqual(sorted(p.name for p in extracted.iterdir()), ["bootstrap", "manifest.json", "polyroute-lambda", "route.cwasm"])
            self.assertEqual((extracted / "bootstrap").stat().st_mode & 0o777, 0o755)
            self.assertEqual((extracted / "polyroute-lambda").read_bytes(), self.host.read_bytes())
            self.assertEqual((extracted / "route.cwasm").read_bytes(), self.component.read_bytes())
            manifest = json.loads((extracted / "manifest.json").read_text())
            self.assertEqual(manifest["component"], "route.cwasm")
            self.assertEqual(manifest["requestsPerInstance"], 1000)
            self.assertEqual(manifest["perRequest"], item["perRequest"])

    def test_changed_component_is_rejected(self):
        self.component.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "component changed"):
            packager.package(self.host, self.fixtures, self.root / "output")

    def test_echo_is_packaged_for_reuse_and_per_request_execution(self):
        for route, limit in [("echo/route.rs", 0), ("go/echo/route.go", 1000)]:
            with self.subTest(route=route):
                fixtures = {route: self.fixtures["go/counter/route.go"]}
                output = self.root / f"output-{limit}"
                packages = packager.package(self.host, fixtures, output)
                self.assertEqual({item["perRequest"] for item in packages}, {False, True})
                self.assertEqual(len(packages), 2)
                for item in packages:
                    manifest = json.loads((output / item["directory"] / "manifest.json").read_text())
                    self.assertEqual(manifest["perRequest"], item["perRequest"])
                    self.assertEqual(manifest["requestsPerInstance"], limit)

    def test_every_shared_case_has_a_matching_extracted_package(self):
        # Collect the actual cases' package requirements without executing guests.
        result = subprocess.run(
            ["node", "--input-type=module", "-e", """
                import { runCases } from './cases.mjs';
                const requirements = [];
                await runCases({
                    check: async (_name, run) => run(),
                    fixture: async (route, options) => {
                        requirements.push({route, perRequest: Boolean(options.perRequest),
                            outboundAllow: options.outboundAllow ?? []});
                    },
                });
                console.log(JSON.stringify(requirements));
            """],
            cwd=Path(__file__).parent, check=True, capture_output=True, text=True,
        )
        requirements = json.loads(result.stdout)
        self.assertTrue(requirements)
        fixtures = {item["route"]: self.fixtures["go/counter/route.go"] for item in requirements}
        output = self.root / "shared-case-packages"
        packages = packager.package(self.host, fixtures, output)
        for required in requirements:
            with self.subTest(required=required):
                matching = [item for item in packages if all(item[key] == value for key, value in required.items())]
                self.assertEqual(len(matching), 1, f"Missing or duplicate package: {required}")
                manifest = json.loads((output / matching[0]["directory"] / "manifest.json").read_text())
                self.assertEqual(manifest["perRequest"], required["perRequest"])
                self.assertEqual(manifest.get("outboundAllow", []), required["outboundAllow"])
                self.assertEqual(manifest["requestsPerInstance"], 1000 if required["route"].startswith("go/") else 0)

    def test_wrong_host_is_rejected(self):
        self.host.write_bytes(b"not ELF")
        with self.assertRaisesRegex(ValueError, "ELF"):
            packager.package(self.host, self.fixtures, self.root / "output")
        self.assertFalse((self.root / "output").exists())


if __name__ == "__main__":
    unittest.main()

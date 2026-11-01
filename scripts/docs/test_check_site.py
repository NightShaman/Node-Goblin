"""Regression coverage for built-site validation at the configured docs mount."""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / 'scripts/docs/check_site.py'


class CheckSiteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.site = Path(self.directory.name)
        (self.site / 'assets').mkdir()
        (self.site / 'assets/logo.png').write_bytes(b'fixture')
        (self.site / 'guide').mkdir()
        (self.site / 'guide/index.html').write_text('<h1 id="install">Install</h1>')
        (self.site / 'index.html').write_text('<a href="guide/#install">Guide</a>')

    def run_check(self, *args):
        return subprocess.run([sys.executable, str(CHECKER), str(self.site), *args],
                              capture_output=True, text=True, check=False)

    def write_404(self, links):
        (self.site / '404.html').write_text(links)

    def test_root_site_default_still_validates(self):
        self.write_404('<img src="/assets/logo.png"><a href="/guide/#install">Guide</a>')
        self.assertEqual(self.run_check().returncode, 0)

    def test_mount_maps_absolute_404_links_and_keeps_relative_pages(self):
        self.write_404('<img src="/node-goblin/assets/logo.png"><a href="/node-goblin/guide/#install">Guide</a>')
        self.assertNotEqual(self.run_check().returncode, 0)
        result = self.run_check('--base-path', '/node-goblin/')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('3 HTML pages; 3 internal links/assets', result.stdout)

    def test_mount_does_not_hide_missing_404_assets(self):
        self.write_404('<img src="/node-goblin/assets/missing.png">')
        result = self.run_check('--base-path', '/node-goblin/')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('404.html: missing target:', result.stderr)

    def test_mount_does_not_hide_missing_fragments(self):
        self.write_404('<a href="/node-goblin/guide/#missing">Guide</a>')
        result = self.run_check('--base-path', '/node-goblin/')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('404.html: missing fragment:', result.stderr)

    def test_mount_rejects_other_roots_and_escape_paths(self):
        for link, error in [('/other/assets/logo.png', 'outside site base'),
                            ('/node-goblin-other/assets/logo.png', 'outside site base'),
                            ('/node-goblin/../../outside.html', 'escapes site')]:
            with self.subTest(link=link):
                self.write_404(f'<a href="{link}">Invalid</a>')
                result = self.run_check('--base-path', '/node-goblin/')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)

    def test_docs_workflow_passes_the_configured_mount(self):
        config = (ROOT / 'mkdocs.yml').read_text()
        site_url = re.search(r'^site_url:\s*(\S+)', config, re.MULTILINE).group(1)
        mount = urlsplit(site_url).path
        workflow = (ROOT / '.github/workflows/docs.yml').read_text()
        self.assertIn(f'python scripts/docs/check_site.py site --base-path {mount}', workflow)


if __name__ == '__main__':
    unittest.main()

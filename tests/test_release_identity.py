"""Displayed release comes only from a valid deployed SHA, never file-controlled markup."""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import SimpleTestCase, RequestFactory
from server.erp import views


class ReleaseIdentityTests(SimpleTestCase):
    def test_release_file_accepts_only_full_git_sha_and_falls_back_without_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'server').mkdir();release=root/'server'/'RELEASE'
            with patch.object(views,'ROOT',root):
                self.assertEqual(views.release_commit(),'unknown')
                for value in [{'commit':'<img src=x onerror=alert(1)>'},{'commit':123},{'commit':'abc123'},[],{'different':'abc'},None]:
                    release.write_text(json.dumps(value))
                    self.assertEqual(views.release_commit(),'unknown')
                release.write_text('{invalid')
                self.assertEqual(views.release_commit(),'unknown')
                sha='5b079bb578a9dfecd53abd18d86fc4aa78118e90'
                release.write_text(json.dumps({'commit':sha}))
                self.assertEqual(views.release_commit(),sha)

    def test_authenticated_html_displays_the_same_release_and_unknown_is_explicit(self):
        request=RequestFactory().get('/');request.portal_user=object()
        sha='5b079bb578a9dfecd53abd18d86fc4aa78118e90'
        with patch.object(views,'RELEASE',sha):
            html=views.handle(request).content.decode()
        self.assertIn('id="applicationVersion">Версія 5b079bb</span>',html)
        self.assertIn('id="applicationCommit">'+sha+'</code>',html)
        with patch.object(views,'RELEASE','unknown'):
            html=views.handle(request).content.decode()
        self.assertIn('id="applicationVersion">Локальна версія</span>',html)
        self.assertIn('id="applicationCommit">Невідомий</code>',html)
        self.assertNotIn(sha,html)
        request.portal_user=None
        self.assertNotIn('applicationCommit',views.handle(request).content.decode())

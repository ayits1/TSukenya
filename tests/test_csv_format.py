import hashlib
import time

from django.contrib.auth.models import User
from django.test import Client, TestCase, SimpleTestCase

from server.erp.csv_format import read_rows
from server.erp.models import Document, PortalSession, Profile, AuditEvent
from server.erp.services import BusinessError


class CsvFormatTests(SimpleTestCase):
    def test_own_text_roundtrip_and_unmarked_text_preserved(self):
        columns, rows = read_rows('"ID [TSukenya CSV 1]";"Назва";"Сума"\r\n"\t=1";"\t\tНазва";"-12.1234"')
        self.assertEqual(columns, ['ID', 'Назва', 'Сума'])
        self.assertEqual(rows, [(2, {'ID': '=1', 'Назва': '\tНазва', 'Сума': '-12.1234'})])
        self.assertEqual(read_rows('ID;Назва\nA;\t=1')[1][0][1]['Назва'], '\t=1')
        self.assertEqual(read_rows('ID;Назва\nA;\'Назва')[1][0][1]['Назва'], "'Назва")

    def test_quoted_separator_detection_and_source_lines(self):
        columns, rows = read_rows('"ID";"Назва, магазин, район, код"\r\n"A";"Лапки ""тут""\nДругий рядок"\r\n"B";"Кава"')
        self.assertEqual(columns, ['ID', 'Назва, магазин, район, код'])
        self.assertEqual(rows[1][0], 4)
        self.assertEqual(rows[0][1][columns[1]], 'Лапки "тут"\nДругий рядок')

    def test_invalid_shape_version_quotes_and_duplicates(self):
        for source in ['"ID [TSukenya CSV 2]";"Назва"', 'ID;ID\nA;B', 'ID;Назва\nA;B;C', 'ID;Назва\n"A;B', 'ID;Назва\n"A"x;B']:
            with self.subTest(source=source), self.assertRaises(BusinessError):
                read_rows(source)


class CsvImportPreviewTests(TestCase):
    def setUp(self):
        user = User.objects.create(username='csv-owner')
        Profile.objects.create(user=user, role='owner')
        token, csrf = 'isolated-csv-token', 'isolated-csv-csrf'
        PortalSession.objects.create(user=user, token_hash=hashlib.sha256(token.encode()).hexdigest(), csrf=csrf, expires=int(time.time())+3600)
        self.client = Client()
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':csrf}
        Document.objects.create(path='products/=id', data={'name':'=Контрольний товар','unit':'шт'})

    def preview(self, source):
        return self.client.post('/api/erp/import-preview', {'csv':source}, content_type='application/json', **self.headers)

    def test_own_template_import_preserves_precise_price_and_lot(self):
        response = self.preview('\ufeff"ID [TSukenya CSV 1]";"Кількість";"Ціна";"Партія";"Придатний до"\r\n"\t=id";"1.125";"12.1234";"\t=партія";""')
        self.assertEqual(response.status_code, 200, response.content)
        line = response.json()['lines'][0]
        self.assertEqual(line['product'], '=id')
        self.assertEqual(line['quantity'], '1.125')
        self.assertEqual(line['price'], '12.1234')
        self.assertEqual(line['lot'], '=партія')
        self.assertFalse(AuditEvent.objects.exists())
        self.assertEqual(Document.objects.count(), 1)

    def test_external_headers_with_many_quoted_commas_use_correct_delimiter(self):
        response = self.preview('"ID";"Кількість";"Ціна";"Назва, код, магазин, район"\n"=id";"1";"2.99";"Кава"')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['lines'][0]['price'], '2.9900')

    def test_bad_csv_returns_actionable_400_without_writes(self):
        for source in ['ID;Кількість;Ціна\n"=id;1;2', 'ID;Кількість;Ціна\n=id;1;2;extra', 'ID;Кількість;Ціна;Ціна\n=id;1;2;3', '"ID [TSukenya CSV 2]";Кількість;Ціна\n=id;1;2']:
            with self.subTest(source=source):
                result = self.preview(source)
                self.assertEqual(result.status_code, 400, result.content)
                self.assertTrue(result.json()['error'])
        self.assertFalse(AuditEvent.objects.exists())
        self.assertEqual(Document.objects.count(), 1)

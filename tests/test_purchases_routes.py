"""The old unbounded HTTP path is retired; the pure oracle remains for parity."""
import json
from unittest.mock import patch
from django.test import SimpleTestCase, RequestFactory
from server.erp.views import handle
from server.erp.services import BusinessError


class PurchasesRoutesTests(SimpleTestCase):
    def test_old_replenishment_is_explicit_410_without_reading_oracle(self):
        request = RequestFactory().get('/api/erp/replenishment')
        request.portal_user = object()
        with patch('server.erp.replenishment.replenishment', side_effect=AssertionError('unbounded read')) as oracle:
            result = handle(request)
        self.assertEqual(result.status_code, 410)
        self.assertEqual(json.loads(result.content), {
            'error': 'Старий список поповнення більше недоступний. Оновіть застосунок.',
            'code': 'endpoint_retired',
            'replacement': '/api/v1/trading/purchases/replenishment',
        })
        oracle.assert_not_called()
        request.portal_user = None
        with self.assertRaises(BusinessError):
            handle(request)

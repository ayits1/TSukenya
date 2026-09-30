import hashlib
import time
from django.http import JsonResponse
from .models import PortalSession

class PortalMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
    def __call__(self, request):
        request.portal_session = None
        request.portal_user = None
        token = request.COOKIES.get('ts_session','')
        if token:
            session = PortalSession.objects.select_related('user__profile').filter(token_hash=hashlib.sha256(token.encode()).hexdigest(), expires__gt=int(time.time()), user__is_active=True).first()
            if session:
                request.portal_session, request.portal_user = session, session.user
        response = self.get_response(request)
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        response['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        response['X-Frame-Options'] = 'DENY'
        response['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        return response

"""P0 reload binding: public identity only; never a permission or credential."""
import time
from django.http import JsonResponse
from django.utils.crypto import salted_hmac
from .historical_reports import read_snapshot
from .models import PortalSession

ROLES={'owner','manager','accountant','warehouse','cashier'}

def session_reply(request, principal):
    with read_snapshot():
        observed=request.portal_session
        session=PortalSession.objects.select_related('user__profile').filter(pk=observed.pk,user_id=principal.pk,expires__gt=int(time.time()),user__is_active=True).first() if observed else None
        if session is None or not hasattr(session.user,'profile') or session.user.profile.role not in ROLES:
            return JsonResponse({'error':'Сеанс більше не чинний. Увійдіть знову.','code':'session_unavailable'},status=401)
        user=session.user;profile=user.profile
        bind=lambda salt,value:salted_hmac(salt,str(value),algorithm='sha256').hexdigest()
        return JsonResponse({'role':profile.role,'csrf':session.csrf,'storeId':profile.store_id,'networkOwner':profile.role=='owner' and profile.store_id is None,
          'draftOwner':bind('tsukenya.draft-owner.v1',user.pk),'draftSession':bind('tsukenya.draft-session.v1',session.pk)})

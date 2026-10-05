"""One shared catalogue operation deadline; nested records never extend it."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from time import monotonic
from .services import BusinessError

_deadline=ContextVar('catalogue_operation_deadline',default=None)
MAX_SECONDS=120


class BudgetExceeded(BusinessError):pass


def check():
    deadline=_deadline.get()
    if deadline is not None and monotonic()>=deadline:
        raise BudgetExceeded('Операція каталогу перевищила ліміт часу. Жоден незавершений пакет не збережено; зменшіть вибір і повторіть перевірку.')


@contextmanager
def budget(seconds=MAX_SECONDS):
    current=_deadline.get();token=_deadline.set(min(current,monotonic()+seconds) if current is not None else monotonic()+seconds)
    try:check();yield
    finally:_deadline.reset(token)


def bounded(function):
    @wraps(function)
    def wrapped(*args,**kwargs):
        with budget():return function(*args,**kwargs)
    return wrapped

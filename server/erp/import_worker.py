"""Supervised local polling runner over the existing durable bounded worker."""
import signal
import threading
import uuid
from django.db import close_old_connections, connections
from .import_jobs import process_one
from .service_health import heartbeat, prune_heartbeats, HEARTBEAT_SECONDS


class ImportWorker:
    def __init__(self,*,identifier=None,poll_seconds=2,output=None):
        self.identifier=identifier;self.poll_seconds=poll_seconds
        self.output=output or (lambda message:None)
        self.stop=threading.Event();self.pulse_stop=threading.Event()
        self.instance=uuid.uuid4();self.release=''

    def pulse(self):
        try:
            while not self.pulse_stop.wait(HEARTBEAT_SECONDS):
                try:
                    close_old_connections();heartbeat(self.instance,self.release)
                except Exception:
                    connections.close_all()
                    self.output('Не вдалося оновити стан worker; наступна спроба за розкладом.')
        finally:connections.close_all()

    def run(self):
        from .views import release_commit
        self.release=release_commit()
        originals={}
        # The OS handler only requests stop. It never interrupts a transaction,
        # resets a run token, marks a chunk successful, or takes another claim.
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGTERM,signal.SIGINT):
                originals[signum]=signal.getsignal(signum)
                signal.signal(signum,lambda _signal,_frame:self.stop.set())
        pulse=None;steps=0
        try:
            prune_heartbeats();heartbeat(self.instance,self.release)
            pulse=threading.Thread(target=self.pulse,name='catalog-import-heartbeat',daemon=True);pulse.start()
            self.output('Worker імпорту запущено; очікуємо збережені пакети.')
            while not self.stop.is_set():
                try:
                    close_old_connections()
                    if process_one(self.identifier):steps+=1
                except Exception:
                    connections.close_all()
                    self.output('Не вдалося прочитати чергу. Повторимо після паузи; збережені пакети залишено.')
                if self.stop.wait(self.poll_seconds):break
            return steps
        finally:
            self.pulse_stop.set()
            if pulse is not None:pulse.join(timeout=5)
            try:
                close_old_connections();heartbeat(self.instance,self.release,stopped=True)
            except Exception:self.output('Зупинено; стан недоступності визначиться після завершення heartbeat інтервалу.')
            connections.close_all()
            for signum,handler in originals.items():signal.signal(signum,handler)
            self.output('Worker зупинено після поточного пакета.')

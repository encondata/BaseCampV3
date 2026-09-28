"""spec-lookup-worker: claim order, private re-check, success/record,
retry backoff, not-configured, refusal, sweep."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import jobs, worker
from serversherpa.spec_lookup.provider import (
    Finding, LookupResult, ProviderFailed, ProviderNotConfigured, ProviderRetryable,
)

URL = "https://www.hpe.com/a"


class FakeProvider:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = []

    async def lookup(self, **kw):
        self.calls.append(kw)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    async def ping(self):
        return None

    async def aclose(self):
        return None


OK = LookupResult(findings=[Finding("ru_size", "1", None, "1U", URL)],
                  seen_urls={URL}, input_tokens=10, output_tokens=5, search_count=1)


async def _setup(db, **kw):
    m = AssetModel(make="HPE", model="DL320", **kw)
    db.add(m)
    await db.flush()
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.commit()
    return m, job


async def _reload(db, cls, id_):
    return await db.scalar(select(cls).where(cls.id == id_).execution_options(populate_existing=True))


async def test_claim_order_priority_then_age(db):
    a = AssetModel(make="A", model="a")
    b = AssetModel(make="B", model="b")
    c = AssetModel(make="C", model="c")
    db.add_all([a, b, c])
    await db.flush()
    db.add(SpecLookupJob(model_id=a.id, priority=0))
    db.add(SpecLookupJob(model_id=b.id, priority=20))
    db.add(SpecLookupJob(model_id=c.id, priority=20,
                         next_attempt_at=datetime.now(UTC) + timedelta(minutes=5)))
    await db.commit()
    job = await jobs.claim_next(db)
    assert job.model_id == b.id and job.status == "running"


async def test_success_records_suggestions(db):
    m, job = await _setup(db)
    p = FakeProvider(OK)
    assert await worker.run_once(get_sessionmaker(), provider_factory=lambda: p) is True
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.finished_at is not None and job.search_count == 1
    assert p.calls[0]["make"] == "HPE" and p.calls[0]["fields"][0] == "ru_size"
    assert (await db.scalar(select(SpecSuggestion))).value == "1"


async def test_private_is_never_sent(db):
    m, job = await _setup(db, private=True)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert p.calls == [] and job.status == "done" and job.error == "private"


async def test_nothing_wanted_finishes_without_a_call(db):
    m, job = await _setup(db, ru_size=1, weight_lbs=1, weight_kg=0.45, length_in=1,
                          length_cm=2.54, width_in=1, width_cm=2.54, height_in=1, height_cm=2.54)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert p.calls == []
    assert (await _reload(db, SpecLookupJob, job.id)).error == "nothing_to_look_up"


async def test_retryable_backs_off_then_fails(db):
    m, job = await _setup(db)
    p = FakeProvider(ProviderRetryable("RateLimitError"))
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "queued" and job.attempts == 1 and job.next_attempt_at is not None
    assert (await _reload(db, AssetModel, m.id)).specs_looked_up_at is None
    job.attempts = worker.MAX_ATTEMPTS - 1
    job.next_attempt_at = None
    await db.commit()
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert (await _reload(db, SpecLookupJob, job.id)).status == "failed"


async def test_retries_exhausted_model_is_not_swept_again(db):
    from serversherpa.db.models import SystemConfig
    m, job = await _setup(db)
    p = FakeProvider(ProviderRetryable("RateLimitError"))
    job.attempts = worker.MAX_ATTEMPTS - 1
    await db.commit()
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed"
    db.add(SystemConfig(section="ai_lookup", data={"background_enabled": True}))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 0


async def test_skip_flag_finishes_without_a_call(db):
    m, job = await _setup(db, spec_lookup_skip=True)
    p = FakeProvider(OK)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert p.calls == []
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.error == "skipped"


async def test_crash_in_record_result_finishes_failed_with_no_suggestions(db, monkeypatch):
    m, job = await _setup(db)
    p = FakeProvider(OK)

    async def _boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr("serversherpa.spec_lookup.worker.service.record_result", _boom)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed" and job.error.startswith("worker_error")
    assert (await db.scalar(select(SpecSuggestion))) is None


async def test_not_configured_and_refusal(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: None)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed" and job.error == "not_configured"
    m2 = AssetModel(make="X", model="y")
    db.add(m2)
    await db.flush()
    job2 = SpecLookupJob(model_id=m2.id)
    db.add(job2)
    await db.commit()
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderFailed("refusal")))
    job2 = await _reload(db, SpecLookupJob, job2.id)
    assert job2.status == "failed" and job2.error == "refusal"
    assert (await _reload(db, AssetModel, m2.id)).specs_looked_up_at is not None


async def test_401_mid_run_is_not_configured(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderNotConfigured("x")))
    assert (await _reload(db, SpecLookupJob, job.id)).error == "not_configured"


async def test_sweep_respects_toggle_and_configuration(db):
    from serversherpa.db.models import SystemConfig
    db.add(AssetModel(make="HPE", model="DL320"))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 0          # background off by default
    db.add(SystemConfig(section="ai_lookup", data={"background_enabled": True}))
    await db.commit()
    assert await worker.sweep(db, provider_configured=False) == 0
    assert await worker.sweep(db, provider_configured=True) == 1


class EditingProvider(FakeProvider):
    """Simulates a user editing the model in the portal while the provider
    call is in flight: a separate session changes the row and commits."""

    def __init__(self, outcome, model_id, **changes):
        super().__init__(outcome)
        self.model_id = model_id
        self.changes = changes
        self.attempts_seen = None

    async def lookup(self, **kw):
        async with get_sessionmaker()() as other:
            row = await other.get(AssetModel, self.model_id)
            for k, v in self.changes.items():
                setattr(row, k, v)
            await other.commit()
        return await super().lookup(**kw)


async def _auto_apply_on(db):
    from serversherpa.db.models import SystemConfig
    db.add(SystemConfig(section="ai_lookup", data={"auto_apply": True}))
    await db.commit()


async def test_user_edit_during_call_is_kept(db):
    m, job = await _setup(db)
    await _auto_apply_on(db)
    p = EditingProvider(OK, m.id, ru_size=4)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    assert (await _reload(db, AssetModel, m.id)).ru_size == 4
    s = await db.scalar(select(SpecSuggestion))
    assert s.status == "pending" and s.previous_value == "4"
    assert (await _reload(db, SpecLookupJob, job.id)).status == "done"


async def test_model_made_private_during_call_stores_nothing(db):
    m, job = await _setup(db)
    await _auto_apply_on(db)
    p = EditingProvider(OK, m.id, private=True)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.error == "private"
    assert (await db.scalar(select(SpecSuggestion))) is None
    assert (await _reload(db, AssetModel, m.id)).ru_size is None


async def test_model_skipped_during_call_stores_nothing(db):
    m, job = await _setup(db)
    p = EditingProvider(OK, m.id, spec_lookup_skip=True)
    await worker.run_once(get_sessionmaker(), provider_factory=lambda: p)
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "done" and job.error == "skipped"
    assert (await db.scalar(select(SpecSuggestion))) is None


async def test_max_tokens_does_not_stamp_looked_up(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderFailed("max_tokens")))
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed" and job.error == "max_tokens"
    assert (await _reload(db, AssetModel, m.id)).specs_looked_up_at is None


async def test_other_provider_failure_stamps_looked_up(db):
    m, job = await _setup(db)
    await worker.run_once(get_sessionmaker(),
                          provider_factory=lambda: FakeProvider(ProviderFailed("bad_output: x")))
    job = await _reload(db, SpecLookupJob, job.id)
    assert job.status == "failed"
    assert (await _reload(db, AssetModel, m.id)).specs_looked_up_at is not None


async def test_attempt_is_committed_before_the_call(db):
    m, job = await _setup(db)
    seen = {}

    class Peek(FakeProvider):
        async def lookup(self, **kw):
            async with get_sessionmaker()() as other:
                seen["attempts"] = (await other.get(SpecLookupJob, job.id)).attempts
            return await super().lookup(**kw)

    await worker.run_once(get_sessionmaker(), provider_factory=lambda: Peek(OK))
    assert seen["attempts"] == 1


async def test_requeue_stale_fails_exhausted_jobs(db):
    old = datetime.now(UTC) - timedelta(hours=1)
    a = AssetModel(make="A", model="a")
    b = AssetModel(make="B", model="b")
    db.add_all([a, b])
    await db.flush()
    spent = SpecLookupJob(model_id=a.id, status="running", started_at=old, heartbeat_at=old,
                          attempts=worker.MAX_ATTEMPTS)
    fresh = SpecLookupJob(model_id=b.id, status="running", started_at=old, heartbeat_at=old,
                          attempts=1)
    db.add_all([spent, fresh])
    await db.commit()
    await jobs.requeue_stale(db)
    spent = await _reload(db, SpecLookupJob, spent.id)
    fresh = await _reload(db, SpecLookupJob, fresh.id)
    assert spent.status == "failed" and spent.error == "stale_retries_exhausted"
    assert spent.finished_at is not None
    assert fresh.status == "queued"


async def test_sweep_stops_after_key_rejected(db):
    from serversherpa.db.models import SystemConfig
    m = AssetModel(make="HPE", model="DL320")
    other = AssetModel(make="X", model="y", specs_looked_up_at=datetime.now(UTC))
    db.add_all([m, other, SystemConfig(section="ai_lookup", data={"background_enabled": True})])
    await db.flush()
    db.add(SpecLookupJob(model_id=other.id, status="failed", error="not_configured",
                         finished_at=datetime.now(UTC) - timedelta(days=3)))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 0
    db.add(SpecLookupJob(model_id=other.id, status="done",
                         finished_at=datetime.now(UTC) - timedelta(days=2)))
    await db.commit()
    assert await worker.sweep(db, provider_configured=True) == 1

"""Project plan mail templates (plan_reminder, plan_assigned,
plan_overdue_digest): each renders through mail.render with its full
context, a missing context key is an error rather than a blank in the
inbox, and user-supplied names are escaped in the HTML part only."""

from html import escape

import pytest
from jinja2 import UndefinedError

from serversherpa.mail.render import render

LINK = "https://portal.example.com/initiatives/abc?tab=plan&task=def"
INITIATIVE = "NAP11 Hall Migration"

REMINDER = {
    "person_name": "Pat", "task_name": "Order crates", "initiative_name": INITIATIVE,
    "due_label": "Thursday, November 5", "stage": "upcoming", "link": LINK}

TASKS = [
    {"name": "Order crates", "start_label": "Mon, Nov 2", "finish_label": "Wed, Nov 4",
     "deadline_label": "Thu, Nov 5"},
    {"name": "Book trucks", "start_label": "Tue, Nov 3", "finish_label": "Fri, Nov 6",
     "deadline_label": None},
]
ASSIGNED = {"person_name": "Pat", "initiative_name": INITIATIVE, "tasks": TASKS,
            "link": LINK, "assigned_by": "Jimmy Henderson"}

DIGEST_TASKS = [
    {"name": "Order crates", "due_label": "Tuesday, November 3", "assignees": "Pat, Sam"},
    {"name": "Book trucks", "due_label": "Monday, November 2", "assignees": "Unassigned"},
]
DIGEST = {"person_name": "Jimmy", "initiative_name": INITIATIVE, "tasks": DIGEST_TASKS,
          "link": LINK}


def _links_to_the_plan(r):
    """The link is in the button and the fallback line, escaped in the HTML
    part (the & of the query string) and raw in the text part."""
    assert r.html.count(f'href="{escape(LINK)}"') == 2
    assert LINK in r.text


CONTEXTS = {"plan_reminder": REMINDER, "plan_assigned": ASSIGNED,
            "plan_overdue_digest": DIGEST}


# plan_reminder ----------------------------------------------------------------

@pytest.mark.parametrize("stage, due_label, subject, sentence", [
    ("upcoming", "Thursday, November 5",
     "Due Thursday, November 5: Order crates — NAP11 Hall Migration",
     "is due Thursday, November 5"),
    ("due", "today",
     "Due today: Order crates — NAP11 Hall Migration",
     "is due today"),
    ("overdue", "since Tuesday, November 3",
     "Overdue: Order crates — NAP11 Hall Migration",
     "has been overdue since Tuesday, November 3"),
])
def test_reminder_subject_and_body_follow_the_stage(stage, due_label, subject, sentence):
    r = render("plan_reminder", **{**REMINDER, "stage": stage, "due_label": due_label})
    assert r.subject == subject
    for part in (r.html, r.text):
        assert "Hi Pat" in part
        assert "Order crates" in part and INITIATIVE in part
        assert sentence in part
    _links_to_the_plan(r)
    assert r.html.lstrip().lower().startswith("<!doctype html>")
    assert r.text.endswith("\n")


def test_reminder_links_with_an_ampersand_in_the_href():
    r = render("plan_reminder", **REMINDER)
    # autoescape turns & into &amp; inside the attribute; the text part keeps it raw
    assert 'href="https://portal.example.com/initiatives/abc?tab=plan&amp;task=def"' in r.html
    assert LINK in r.text


def test_reminder_escapes_names_in_html_but_not_text():
    r = render("plan_reminder", **{**REMINDER, "task_name": "<b>Crates</b>",
                                   "initiative_name": "A & B"})
    assert "&lt;b&gt;Crates&lt;/b&gt;" in r.html and "<b>Crates</b>" not in r.html
    assert "A &amp; B" in r.html
    assert "<b>Crates</b>" in r.text and "A & B" in r.text


def test_reminder_subject_is_one_line_whatever_the_names_hold():
    r = render("plan_reminder", **{**REMINDER, "task_name": "Order\r\ncrates\nnow"})
    assert "\n" not in r.subject and "\r" not in r.subject
    assert r.subject == "Due Thursday, November 5: Order crates now — NAP11 Hall Migration"


# plan_assigned ----------------------------------------------------------------

def test_assigned_lists_every_task_with_its_dates_and_deadline():
    r = render("plan_assigned", **ASSIGNED)
    assert r.subject == f"You were assigned 2 tasks in {INITIATIVE}"
    for part in (r.html, r.text):
        assert "Hi Pat" in part
        assert "Jimmy Henderson" in part
        assert "Order crates" in part and "Book trucks" in part
        assert "Mon, Nov 2" in part and "Wed, Nov 4" in part
        assert "Tue, Nov 3" in part and "Fri, Nov 6" in part
    _links_to_the_plan(r)
    # only the task that has a deadline mentions one
    for part in (r.html, r.text):
        assert part.count("Thu, Nov 5") == 1
        assert part.lower().count("deadline") == 1


def test_assigned_subject_is_singular_for_one_task():
    r = render("plan_assigned", **{**ASSIGNED, "tasks": TASKS[:1]})
    assert r.subject == f"You were assigned 1 task in {INITIATIVE}"
    assert "task(s)" not in r.html and "task(s)" not in r.text


def test_assigned_without_an_assigner_still_reads_well():
    r = render("plan_assigned", **{**ASSIGNED, "assigned_by": None})
    assert "None" not in r.html and "None" not in r.text
    assert r.subject == f"You were assigned 2 tasks in {INITIATIVE}"


def test_assigned_escapes_task_names_in_html_but_not_text():
    tasks = [{**TASKS[0], "name": "<script>alert(1)</script>"}]
    r = render("plan_assigned", **{**ASSIGNED, "tasks": tasks})
    assert "<script>" not in r.html and "&lt;script&gt;" in r.html
    assert "<script>alert(1)</script>" in r.text


def test_assigned_task_without_a_deadline_key_is_an_error():
    # None means "no deadline"; leaving the key out is a caller bug
    tasks = [{"name": "A", "start_label": "s", "finish_label": "f"}]
    with pytest.raises(UndefinedError):
        render("plan_assigned", **{**ASSIGNED, "tasks": tasks})


# plan_overdue_digest ----------------------------------------------------------

def test_digest_lists_overdue_tasks_with_due_date_and_assignees():
    r = render("plan_overdue_digest", **DIGEST)
    assert r.subject == f"2 overdue tasks in {INITIATIVE}"
    for part in (r.html, r.text):
        assert "Hi Jimmy" in part
        assert "Order crates" in part and "Book trucks" in part
        assert "Tuesday, November 3" in part and "Monday, November 2" in part
        assert "Pat, Sam" in part and "Unassigned" in part
    _links_to_the_plan(r)


def test_digest_subject_is_singular_for_one_task():
    r = render("plan_overdue_digest", **{**DIGEST, "tasks": DIGEST_TASKS[:1]})
    assert r.subject == f"1 overdue task in {INITIATIVE}"
    assert "task(s)" not in r.html and "task(s)" not in r.text


def test_digest_takes_assignees_as_a_list_too():
    tasks = [{**DIGEST_TASKS[0], "assignees": ["Pat", "Sam"]}]
    r = render("plan_overdue_digest", **{**DIGEST, "tasks": tasks})
    assert "Pat, Sam" in r.html and "Pat, Sam" in r.text


def test_digest_escapes_names_in_html_but_not_text():
    tasks = [{**DIGEST_TASKS[0], "name": "<i>x</i>", "assignees": "A & B"}]
    r = render("plan_overdue_digest", **{**DIGEST, "tasks": tasks})
    assert "&lt;i&gt;x&lt;/i&gt;" in r.html and "A &amp; B" in r.html
    assert "<i>x</i>" in r.text and "A & B" in r.text


# every template ---------------------------------------------------------------

@pytest.mark.parametrize("template, context", CONTEXTS.items())
def test_every_documented_key_is_used_and_required(template, context):
    """StrictUndefined: dropping any one context key raises, so a key a
    template never reads (and would silently ignore) fails here too."""
    assert render(template, **context).subject
    for key in context:
        partial = {k: v for k, v in context.items() if k != key}
        with pytest.raises(UndefinedError):
            render(template, **partial)


@pytest.mark.parametrize("template, context", CONTEXTS.items())
def test_every_template_extends_the_base_layout(template, context):
    r = render(template, **context)
    assert "ServerSherpa" in r.html and "<title>" in r.html
    assert r.subject in r.html
    assert "{{" not in r.html and "{%" not in r.html
    assert "{{" not in r.text and "{%" not in r.text

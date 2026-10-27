"""Sample content for `serversherpa learning-seed`: the wiki pages (as
ProseMirror JSON), their learning-document settings, quiz questions and
packets. Every page opens with the same "replace this text" callout.

The node helpers are copied from the wiki guide scripts' wikidoc.py (the
CLI never imports from .superpowers). Inline text uses **bold** markers
and never emits an empty text node, which the wiki schema rejects."""
import re
from dataclasses import dataclass, field
from typing import Any

SAMPLE_NOTICE = "Sample document. Replace this text with your company's policy before you assign it."
DOC_TYPE = "Policy"


def _inline(s: str) -> list[dict]:
    out = []
    for i, part in enumerate(re.split(r"\*\*", s)):
        if not part:
            continue
        node: dict[str, Any] = {"type": "text", "text": part}
        if i % 2 == 1:
            node["marks"] = [{"type": "bold"}]
        out.append(node)
    return out


def p(s: str) -> dict:
    content = _inline(s)
    return {"type": "paragraph", "content": content} if content else {"type": "paragraph"}


def h2(s: str) -> dict:
    return {"type": "heading", "attrs": {"level": 2}, "content": _inline(s)}


def bullets(*items: str) -> dict:
    return {"type": "bulletList", "content": [
        {"type": "listItem", "content": [p(i)]} for i in items]}


def steps(*items: str) -> dict:
    return {"type": "orderedList", "attrs": {"start": 1}, "content": [
        {"type": "listItem", "content": [p(i)]} for i in items]}


def callout(variant: str, *paras: str) -> dict:
    return {"type": "callout", "attrs": {"variant": variant},
            "content": [p(x) for x in paras]}


def doc(*nodes: dict) -> dict:
    """A page: the sample notice first, then `nodes`."""
    return {"type": "doc", "content": [callout("info", SAMPLE_NOTICE), *nodes]}


def empty_text_nodes(node: dict) -> int:
    if node.get("type") == "text" and not node.get("text"):
        return 1
    return sum(empty_text_nodes(c) for c in node.get("content", []))


# ── the pages ────────────────────────────────────────────────────────

DRESS_CODE = doc(
    p("What to wear on every client site, and why it matters."),
    h2("Every day on site"),
    bullets(
        "Company shirt, tucked in, with your badge visible above the waist.",
        "Long pants. No shorts, leggings or ripped denim.",
        "Closed-toe safety shoes. Steel toe where the site requires it.",
    ),
    h2("Data hall floor"),
    bullets(
        "No loose jewelry, lanyards that hang below the chest, or untied long hair.",
        "ESD wrist strap when you handle open equipment.",
    ),
    h2("Client-specific rules"),
    p("Some clients add their own rules. You'll see them in that client's site rules packet."),
    h2("If you are not sure"),
    p("Ask your lead before you start. Being turned away at the door costs you and the crew "
      "more time than a quick question does."),
)

CONFIDENTIALITY = doc(
    p("How we handle what we see and hear at client sites."),
    h2("What is confidential"),
    bullets(
        "Who our clients are, and which of their equipment we move, install or retire.",
        "Floor plans, rack layouts, badge systems, network details and anything labeled "
        "confidential.",
        "Asset lists, serial numbers and the schedule for any job.",
    ),
    h2("What you can say"),
    p("If someone outside the job asks what you do, say you work on data center moves. "
      "Don't name the client, the site or the equipment."),
    h2("Photos and devices"),
    bullets(
        "Take photos only when your lead asks for them, and only with company devices.",
        "Never post anything from a client site on social media, even if it looks harmless.",
        "Keep client paperwork out of sight, and shred or return it when the job ends.",
    ),
    h2("If something goes wrong"),
    p("Tell your lead right away if you lose a badge, a device or a document, or if you "
      "think you shared something you shouldn't have. Reporting early is always better "
      "than reporting late."),
)

WORK_EXPECTATIONS = doc(
    p("What we expect from everyone on a crew, and what you can expect from us."),
    h2("Show up ready"),
    bullets(
        "Arrive on time and check in with your lead before you start.",
        "Bring your badge, your safety shoes and any tools you were asked to bring.",
        "If you'll be late or can't come, tell your lead as early as you can.",
    ),
    h2("Work safely"),
    bullets(
        "Lift with a partner or a cart when a load is too heavy or awkward.",
        "Stop and speak up if something looks unsafe. No job is worth an injury.",
        "Report every injury and near miss to your lead the same day.",
    ),
    h2("Respect people and equipment"),
    bullets(
        "Treat clients, site staff and your crew with courtesy.",
        "Handle equipment as if it were your own. Scan it, label it and place it where "
        "the job says it goes.",
        "Leave every area cleaner than you found it.",
    ),
    h2("Time and records"),
    p("Clock in and out on the time clock at your station, and scan every asset you move. "
      "Accurate records keep your pay right and keep the client's inventory right."),
)

ACME_SITE_RULES = doc(
    p("Extra rules for Acme sites. They apply on top of the standard onboarding documents."),
    h2("Getting in"),
    steps(
        "Check in at the security desk with your badge and a photo ID.",
        "Wait for your escort. Don't enter the data hall alone.",
        "Sign the visitor log when you arrive and when you leave.",
    ),
    h2("Moving around the site"),
    bullets(
        "Stay on the route your escort shows you.",
        "Keep doors closed behind you. Never prop a door open.",
        "Park only in the spaces marked for contractors.",
    ),
    h2("Loading dock and freight elevator"),
    bullets(
        "Check in with the dock supervisor before you load or unload.",
        "Use the freight elevator for equipment and the passenger elevator for people.",
        "Keep walkways and fire exits clear at all times.",
    ),
    h2("When you leave"),
    p("Return your visitor badge, take every tool and all your packing material with you, "
      "and tell your lead about anything you left unfinished."),
)

ACME_NDA = doc(
    p("A short non-disclosure agreement for work on Acme equipment and sites."),
    h2("What this covers"),
    p("This agreement covers everything you learn about Acme while you work for us: its "
      "equipment, its sites, its people and its plans. It stays in force after the job ends."),
    h2("What you agree to"),
    bullets(
        "Keep Acme information private and use it only to do the job.",
        "Never share it with anyone who isn't on the job, including friends and family.",
        "Never take copies of Acme documents, drawings or data off site.",
    ),
    h2("What you can say"),
    p("If someone asks about your work, say only that you are working on a data center move. "
      "Don't name Acme, the site or the equipment."),
    h2("If you slip"),
    p("Tell your lead right away if you think you shared something you shouldn't have. "
      "Acting early lets us fix it before it becomes a problem."),
)

FORKLIFT = doc(
    p("The basics of operating a forklift safely on a client site."),
    h2("Before you drive"),
    bullets(
        "Only certified operators may drive a forklift. If you aren't certified, don't.",
        "Do the daily check: tires, forks, horn, lights, brakes and the seat belt.",
        "Tag out any truck with a problem and tell your lead.",
    ),
    h2("While you drive"),
    bullets(
        "Wear your seat belt and keep your hands and feet inside the truck.",
        "Carry loads low, tilted back, and look in the direction you are traveling.",
        "Slow down at corners and doorways, and sound the horn at blind spots.",
        "Never carry passengers, and never lift a person on the forks.",
    ),
    h2("Around people"),
    p("Pedestrians always have the right of way. Stop and make eye contact before you "
      "move when someone is nearby."),
    h2("When you park"),
    p("Lower the forks to the floor, set the brake, turn the truck off and take the key "
      "with you. Park only in the marked areas, never in an aisle or a fire exit."),
)


# ── what each page becomes ───────────────────────────────────────────

@dataclass(frozen=True)
class Question:
    prompt: str
    choices: list[str]
    correct: int                   # index into `choices`


@dataclass(frozen=True)
class SeedDoc:
    folder: str
    title: str                     # the wiki page and the learning document
    content: dict
    summary: str
    settings: dict = field(default_factory=dict)    # LearningDocument columns
    questions: tuple[Question, ...] = ()
    change_note: str = "First version (sample)."


YEAR = 365

DOCUMENTS: tuple[SeedDoc, ...] = (
    SeedDoc("Standard onboarding", "Dress code", DRESS_CODE,
            "What to wear on every client site, and why it matters.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version",
             "sign_style": "typed_name", "require_scroll": True, "min_read_seconds": 60}),
    SeedDoc("Standard onboarding", "Confidentiality", CONFIDENTIALITY,
            "How we handle what we see and hear at client sites.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version"}),
    SeedDoc("Standard onboarding", "Work expectations", WORK_EXPECTATIONS,
            "What we expect from everyone on a crew, and what you can expect from us.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version"}),
    SeedDoc("Client site rules", "Acme site rules (sample)", ACME_SITE_RULES,
            "Extra rules for Acme sites.",
            {"resign_rule": "every_initiative"}),
    SeedDoc("Client site rules", "Acme NDA (sample)", ACME_NDA,
            "A short non-disclosure agreement for work on Acme equipment and sites.",
            {"resign_rule": "every_initiative", "quiz_enabled": True,
             "quiz_pass_percent": 75, "quiz_max_attempts": 3, "quiz_fail_action": "retry"},
            questions=(
                Question("Who does this agreement protect?",
                         ["Acme and its information", "Only our company",
                          "Only the workers on the job"], 0),
                Question("A friend asks which company's equipment you're moving this week. "
                         "What can you say?",
                         ["The client's name, but nothing else",
                          "Only that you're working on a data center move",
                          "Anything, as long as it's not posted online"], 1),
                Question("You think you shared something you shouldn't have. What do you do?",
                         ["Wait to see whether anyone notices",
                          "Tell your lead right away",
                          "Delete the message and say nothing"], 1),
                Question("May you take copies of Acme documents off site?",
                         ["Yes, if you return them next week",
                          "Yes, if they are only for your own notes",
                          "No, never"], 2),
            )),
    SeedDoc("Extras", "Forklift safety (sample)", FORKLIFT,
            "The basics of operating a forklift safely on a client site.",
            {"validity_days": YEAR}),
)

FOLDERS = ("Standard onboarding", "Client site rules", "Extras")

# (packet name, description, document titles in order)
PACKETS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Standard onboarding", "What every worker reviews and signs before working on site.",
     ("Dress code", "Confidentiality", "Work expectations")),
    ("Acme site rules", "Site rules and the NDA for Acme initiatives.",
     ("Acme site rules (sample)", "Acme NDA (sample)")),
    ("Forklift safety", "Safe forklift operation, for certified operators.",
     ("Forklift safety (sample)",)),
)

# the one rule the seed creates: everyone gets Standard onboarding
EVERYONE_RULE = ("Everyone → Standard onboarding", "Standard onboarding")

SPACE = {"key": "learning", "name": "Learning",
         "description": "Training documents workers review and sign before working on site.",
         "default_access": "internal"}

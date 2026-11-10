"""Sample content for `serversherpa learning-seed`: the wiki pages (as
ProseMirror JSON), their learning-document settings, quiz questions and
packets. Every sample page opens with the same "replace this text"
callout; Dress code, Labels, the loading dock and the rack server pages
are the company's own slides, so they have none.

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


def image(filename: str, caption: str) -> dict:
    """An image from `seed_images/`. The seed uploads it as the page's own
    asset and swaps the `file:` id for the asset's (`image_files`)."""
    return {"type": "wikiImage",
            "attrs": {"alt": caption, "assetId": "file:" + filename, "caption": caption}}


def doc(*nodes: dict, sample: bool = True) -> dict:
    """A page: the sample notice first (unless not `sample`), then `nodes`."""
    notice = [callout("info", SAMPLE_NOTICE)] if sample else []
    return {"type": "doc", "content": [*notice, *nodes]}


def image_nodes(node: dict) -> list[dict]:
    """The `wikiImage` nodes in `node` that still name a `seed_images/` file."""
    if node.get("type") == "wikiImage":
        return [node] if str(node["attrs"]["assetId"]).startswith("file:") else []
    return [n for c in node.get("content", []) for n in image_nodes(c)]


def empty_text_nodes(node: dict) -> int:
    if node.get("type") == "text" and not node.get("text"):
        return 1
    return sum(empty_text_nodes(c) for c in node.get("content", []))


# ── the pages ────────────────────────────────────────────────────────

# the dress code slides; every word below is on them
DRESS_CODE = doc(
    p("What to wear for every visit."),
    image("dress-code-01.webp", "Datacenter dress code"),
    bullets("Long pants", "Closed-toe shoes", "Solid-color collared shirt",
            "Name badge on the right chest"),
    h2("Shirt and name badge"),
    image("dress-code-02.webp", "Shirt and name badge"),
    bullets("**Solid-color collared shirt.** No logos, branding or patterns.",
            "**Name badge on the right chest.** Wear your badge where it is easy to see."),
    h2("Pants and footwear"),
    image("dress-code-03.webp", "Pants and footwear"),
    bullets("**Long pants.** Wear full-length pants. No shorts.",
            "**Closed-toe shoes.** Keep your toes fully covered. No sandals or open-toe shoes."),
    h2("Before you enter"),
    image("dress-code-04.webp", "Before you enter: your dress code checklist"),
    bullets("Long pants", "Closed-toe shoes", "Solid-color collared shirt with no branding",
            "Name badge on your right chest"),
    sample=False,
)

# the label slides, one per heading; every word below is on them
LABELS = doc(
    h2("How to read our labels"),
    image("labels-01.webp", "How to read our labels"),
    p("**Front label.** Asset identity, source and target."),
    bullets("**Target** = destination", "**RU** = rack-unit position",
            "**Source** = starting location"),
    p("**Top label.** Destination for reinstallation."),
    bullets("**DH2-R14** = destination rack", "**12** = destination RU"),
    p("Location information is destination only."),
    p("**Front label colors only**"),
    bullets("**White · Normal.** Standard assets included in the move.",
            "**Yellow · Priority.** Extra care. Move first.",
            "**Red · Second priority.** Move second, after all yellow-tagged devices are "
            "removed.",
            "**Blue · Vendor.** Handled by vendors."),
    h2("Front label placement"),
    image("labels-02.webp", "Front label placement"),
    p("**Front panel. Toward the right.**"),
    steps("**Apply while in the rack.** Place the front label while the server is still "
          "installed.",
          "**Position toward the right.** Apply the label to the right side of the front panel.",
          "**Keep the power button clear.** Leave the power button visible and accessible."),
    h2("RFID tag placement"),
    image("labels-03.webp", "RFID tag placement"),
    p("**Top-left attachment. Front-facing flag.**"),
    steps('**Fold under the middle.** Fold the "Fold Down" third under the middle section to '
          "create a double-thickness flag.",
          "**Attach at the top left.** Apply the sticky section on top, about 1 in / 2.5 cm "
          "from the server's left edge, as viewed from the front.",
          "**Keep the flag close.** Fold the doubled section over the front edge so it lies "
          "as close to the server's front face as possible."),
    h2("Top label placement"),
    image("labels-04.webp", "Top label placement"),
    p("**Top surface. Front-right corner.**"),
    steps("**Place at the far right.** On the top of the server, as viewed from the front.",
          "**Set back from the front.** About 1 in / 2.5 cm from the front edge.",
          "**Face the label forward.** Keep it readable when standing in front of the server."),
    h2("Rail label placement"),
    image("labels-05.webp", "Rail label placement"),
    p("**Paired rails. Matching label.**"),
    steps("**Tape the rails as a pair.** Use 2–3 wraps of blue tape near each end.",
          "**Label the flat section.** Apply the matching top label in the center of one "
          "rail's flat section.",
          "**Keep with its server.** Keep the labeled rail pair with the server it belongs to."),
    sample=False,
)

# the loading dock slides, one per heading; every word below is on them
CRATING = doc(
    h2("Load servers into crates"),
    image("crating-01.webp", "Load servers into crates"),
    steps("**Standard servers.** Build a left stack and a right stack.",
          "**Larger devices.** Stack deeper, taller devices with labels facing forward."),
    bullets("**Maximum 10 servers per stack.**",
            "**Protective foam.** Place protective foam between every server and on top of "
            "each stack.",
            "Place matching rails on top of the servers in the same crate."),
    p("**All labels must face the same direction — toward the open front.**"),
    h2("Unpack and group servers"),
    image("crating-02.webp", "Unpack and group servers"),
    steps("**Check the top label.** When possible, group servers going to the same "
          "destination rack.",
          "**Keep matching rails together.** Place rails on top of the stack containing "
          "their matching servers."),
    p("**Cart stacks: 10 RU maximum • Use two people for server transfers**"),
    sample=False,
)

# the server handling slides, one per heading; every word below is on them
RACK_SERVERS = doc(
    h2("Two-person server removal"),
    image("rack-servers-01.webp", "Two-person server removal"),
    p("**Always use two people.**"),
    steps("**Support together.** Both people support the server before it clears the rack.",
          "**Keep it level.** Maintain a secure grip as the server comes free.",
          "**Lower together.** Coordinate the movement and lower onto the cart.",
          "**Keep rails with their server.** Remove the rails. Tape them together as a pair "
          "with 2–3 wraps of blue tape near each end. Keep the pair on the stack with its "
          "server."),
    p("**Two people. Every server.** Server stacks on carts must not exceed 10 RU."),
    h2("Heavy-server removal with a lift cart"),
    image("rack-servers-02.webp", "Heavy-server removal with a lift cart"),
    p("**Use a lift cart and two people.**"),
    steps("**Position and raise the cart.** Place the cart in front of the rack. Lock the "
          "casters and raise the platform to the server.",
          "**Guide onto the platform.** With two people, slide the server onto the lift "
          "platform and keep it fully supported.",
          "**Lower the platform.** Once the server is fully on the cart, lower the platform "
          "slowly.",
          "**Keep rails with their server.** Remove the rails. Pair them with 2–3 wraps of "
          "blue tape near each end and keep them with their server."),
    p("**Two people. Every server.** Server stacks on carts must not exceed 10 RU."),
    h2("Two-person server reinstallation"),
    image("rack-servers-03.webp", "Two-person server reinstallation"),
    p("**Always use two people.**"),
    steps("**Prepare the matching rails.** Confirm the assigned rack position. Remove the "
          "blue tape and install the rails that belong to the server.",
          "**Lift together.** With one person on each side, lift the server from the cart. "
          "Keep it level and supported.",
          "**Align and slide into place.** Align the server with both rails. Guide it into "
          "the rack together without forcing it.",
          "**Secure the server.** Confirm the server is fully seated and secured before "
          "releasing your support."),
    p("**Two people. Every server.** Server stacks on carts must not exceed 10 RU."),
    h2("Heavy-server installation with a lift cart"),
    image("rack-servers-04.webp", "Heavy-server installation with a lift cart"),
    p("**Use a lift cart and two people.**"),
    steps("**Install the matching rails.** Remove the blue tape from the paired rails. Fit "
          "them at the assigned rack position and confirm they are secure.",
          "**Position and align the cart.** Place the cart in front of the rack. Lock the "
          "casters and raise the server to align with the rails.",
          "**Guide into the rack.** With two people, engage the rails and slide the server "
          "into the rack. Keep it supported throughout.",
          "**Secure before lowering.** Confirm the server is fully seated and secured before "
          "lowering and moving the cart away."),
    p("**Two people. Every server.** Server stacks on carts must not exceed 10 RU."),
    sample=False,
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
            "What to wear for every visit.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version",
             "sign_style": "typed_name", "require_scroll": True, "min_read_seconds": 60,
             "reading_style": "slides"},
            change_note="First version."),
    SeedDoc("Standard onboarding", "Labels", LABELS,
            "How to read our labels, and where front, top, rail and RFID labels go.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version",
             "sign_style": "typed_name", "require_scroll": True, "min_read_seconds": 60,
             "reading_style": "slides"},
            change_note="First version."),
    SeedDoc("Standard onboarding", "Loading dock crating process", CRATING,
            "How to load servers into crates and unpack them at the loading dock.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version",
             "sign_style": "typed_name", "require_scroll": True, "min_read_seconds": 60,
             "reading_style": "slides"},
            change_note="First version."),
    SeedDoc("Standard onboarding", "Server removal and installation in racks", RACK_SERVERS,
            "How two people take servers out of racks and put them back, by hand or with a "
            "lift cart.",
            {"validity_days": YEAR, "resign_rule": "expired_or_new_version",
             "sign_style": "typed_name", "require_scroll": True, "min_read_seconds": 60,
             "reading_style": "slides"},
            change_note="First version."),
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
     ("Dress code", "Labels", "Loading dock crating process",
      "Server removal and installation in racks", "Confidentiality", "Work expectations")),
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

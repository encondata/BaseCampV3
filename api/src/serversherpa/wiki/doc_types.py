"""The document types a page can carry — shown on the cover of an
exported PDF. The API validates against `DOC_TYPES`; the column itself is
free text so adding a type is a code change only."""

DOC_TYPES = ("Operating Procedure", "Work Instruction", "Guide", "Policy", "Reference")

# a page created from one of these built-in templates starts with this type
TEMPLATE_DOC_TYPES = {"SOP": "Operating Procedure"}

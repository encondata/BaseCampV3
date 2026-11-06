"""Splitting a Slides document's stored HTML into slides: one slide per
top-level level-2 heading, the opening content before the first heading
as its own slide, nothing inside a callout or other container split."""
from serversherpa.learning.slides import slide_count, split_slides

# the stored Dress code v2 shape: intro + figure + list, then three h2 sections
DRESS_HTML = (
    '<p>What to wear for every visit.</p>'
    '<figure data-wiki-image="11111111-1111-1111-1111-111111111111">'
    '<img alt="Datacenter dress code"><figcaption>Datacenter dress code</figcaption></figure>'
    '<ul><li>Shirt</li><li>Pants</li></ul>'
    '<h2>Shirt and name badge</h2>'
    '<figure data-wiki-image="22222222-2222-2222-2222-222222222222">'
    '<img alt="Shirt and name badge"><figcaption>Shirt and name badge</figcaption></figure>'
    '<ul><li>Company shirt</li></ul>'
    '<h2>Pants and footwear</h2>'
    '<figure data-wiki-image="33333333-3333-3333-3333-333333333333">'
    '<img alt="Pants and footwear"><figcaption>Pants and footwear</figcaption></figure>'
    '<ul><li>Steel toes</li></ul>'
    '<h2>Before you enter: your dress code checklist</h2>'
    '<figure data-wiki-image="44444444-4444-4444-4444-444444444444">'
    '<img alt="Checklist"><figcaption>Checklist</figcaption></figure>'
    '<ul><li>Badge on</li></ul>')


def test_split_at_top_level_h2():
    html = "<p>Intro</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>"
    assert split_slides(html) == ["<p>Intro</p>", "<h2>A</h2><p>a</p>", "<h2>B</h2><p>b</p>"]


def test_no_intro_when_page_starts_with_h2():
    assert split_slides("<h2>A</h2><p>a</p><h2>B</h2>") == ["<h2>A</h2><p>a</p>", "<h2>B</h2>"]
    assert split_slides("  \n<h2>A</h2>") == ["<h2>A</h2>"]


def test_no_h2_is_one_slide():
    assert split_slides("<p>x</p><h3>y</h3>") == ["<p>x</p><h3>y</h3>"]
    assert split_slides("") == [""]


def test_nested_h2_does_not_split():
    html = '<div data-callout="info"><h2>In a callout</h2></div><h2>A</h2><img src="x"><p>a</p>'
    assert split_slides(html) == ['<div data-callout="info"><h2>In a callout</h2></div>',
                                  '<h2>A</h2><img src="x"><p>a</p>']


def test_void_elements_do_not_nest():
    # an <img> or <br> never closes, so it must not hold the depth above zero
    html = '<p>a<br>b</p><img src="x"><h2>A</h2><hr><h2>B</h2>'
    assert split_slides(html) == ['<p>a<br>b</p><img src="x">', "<h2>A</h2><hr>", "<h2>B</h2>"]


def test_slides_are_exact_substrings():
    # attribute quoting, entities and presigned URLs survive untouched
    html = ('<h2>A &amp; B</h2><img src="https://x/y?a=1&amp;b=2" alt=\'q\'>'
            '<h2>C</h2><p>&lt;z&gt;</p>')
    slides = split_slides(html)
    assert "".join(slides) == html
    assert slides[0] == '<h2>A &amp; B</h2><img src="https://x/y?a=1&amp;b=2" alt=\'q\'>'


def test_dress_code_html_is_four_slides():
    assert slide_count(DRESS_HTML) == 4
    slides = split_slides(DRESS_HTML)
    assert slides[0].startswith("<p>What to wear") and slides[1].startswith("<h2>Shirt")
    assert "".join(slides) == DRESS_HTML

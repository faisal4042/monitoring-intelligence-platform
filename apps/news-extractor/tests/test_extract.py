"""Extraction from fixed fixtures: metadata, Arabic body cleaning, no merging
of neighbouring stories, source-specific rules, validation, hashing."""
from scrapling.parser import Selector

from app.extract import sites
from app.extract.cleaning import clean_paragraphs, content_hash, simhash64
from app.extract.content import extract_body, parse_tree
from app.extract.metadata import extract_metadata, parse_date
from app.extract.validate import validate

from conftest import fixture_html


def _run(name: str, url: str):
    body = fixture_html(name)
    page = Selector(content=body, url=url, encoding="utf-8")
    meta = extract_metadata(page, url)
    rule = sites.rule_for(url.split("/")[2])
    site = sites.apply(rule, page, False) if rule else None
    return meta, extract_body(parse_tree(body, "utf-8"), site, meta.get("title"))


def test_jsonld_and_open_graph():
    meta, _ = _run("arabic_article.html", "https://news.example.sa/article/12345")
    assert meta["title"] == "الهيئة العامة للعقار تطلق خدمة جديدة لتوثيق العقود"
    assert meta["published_at"] == "2026-10-05T09:30:00+03:00"
    assert meta["modified_at"] == "2026-10-05T11:00:00+03:00"
    assert meta["authors"] == ["سارة العتيبي"]
    assert meta["publisher"] == "صحيفة الاختبار"
    assert meta["image_url"] == "https://news.example.sa/images/lead.jpg"
    assert meta["language"] == "ar"
    assert meta["categories"] == ["اقتصاد"]
    assert {"عقار", "إيجار", "توثيق"} <= set(meta["tags"])
    assert "newsarticle" in meta["jsonld_types"]


def test_canonical_url_is_resolved_absolute():
    meta, _ = _run("arabic_article.html", "https://news.example.sa/article/12345")
    assert meta["canonical_url"] == "https://news.example.sa/article/12345?utm_source=feed"
    meta, _ = _run("english_article.html", "https://en.example.com/x?y=1")
    assert meta["canonical_url"] == "https://en.example.com/2026/10/lease-service"


def test_arabic_body_keeps_facts_and_drops_furniture():
    _, body = _run("arabic_article.html", "https://news.example.sa/article/12345")
    text = "\n".join(body.paragraphs)
    # Numbers, names and percentages survive untouched.
    for fact in ("15 دقيقة", "1,200 مكتب", "125 ريالاً", "48,500 عقد", "92.4%", "م. خالد الشمري", "رؤية 2030"):
        assert fact in text
    # Furniture, neighbours and the sidebar do not.
    for noise in ("شارك", "تابعونا", "اقرأ أيضاً", "خبر مجاور", "الأكثر قراءة", "جميع الحقوق", "إعلان", "الرئيسية"):
        assert noise not in text, noise
    # The duplicated paragraph appears once, order is preserved.
    assert text.count("48,500") == 1
    assert text.index("15 دقيقة") < text.index("1,200") < text.index("48,500")


def test_missing_date_is_not_invented_and_neighbours_not_merged():
    meta, body = _run("listing_no_date.html", "https://momah.example.sa/news")
    assert meta["published_at"] is None and meta["authors"] == []
    text = "\n".join(body.paragraphs)
    assert "7,300" in text
    assert "معرض الكتاب" not in text  # the adjacent story stays out


def test_english_article_and_language_check():
    meta, body = _run("english_article.html", "https://en.example.com/x")
    text = "\n\n".join(body.paragraphs)
    assert "48,500 contracts" in text and "Share this article" not in text and "All rights reserved" not in text
    assert meta["authors"] == ["Jane Doe"]
    assert validate(text, meta["title"], "en").status == "complete"
    assert validate(text, meta["title"], "ar").reason == "unexpected_language"


def test_source_specific_rule_reads_nextjs_payload():
    _, body = _run("nextjs_flight.html", "https://ajel.sa/local/abc")
    text = "\n".join(body.paragraphs)
    assert body.strategy == "site"
    assert "منصة إطلاق الصواريخ" in text and "3 مواقع" in text
    assert "خارج جسم الخبر" not in text


def test_invalid_html_does_not_crash():
    broken = extract_body(parse_tree(b"<html><body><p>unclosed <div><<<>>>", "utf-8"), None, None)
    assert broken.strategy in ("none", "scored") and all(isinstance(p, str) for p in broken.paragraphs)
    assert extract_body(parse_tree(b"", "utf-8"), None, None).strategy == "none"
    assert extract_body(parse_tree(bytes([0xFF, 0xFE, 0x00]) + b"garbage", "windows-1256"), None, None).paragraphs == []


def test_dates():
    assert parse_date("2026-10-05T09:30:00Z") == "2026-10-05T09:30:00+00:00"
    assert parse_date("Sun, 05 Oct 2026 09:30:00 +0300") == "2026-10-05T09:30:00+03:00"
    assert parse_date("2026-10-05 09:30:00").endswith("+03:00")  # zone-less Saudi publisher time
    assert parse_date("2099-01-01T00:00:00Z") is None            # future: a wrong clock, not news
    assert parse_date("not a date") is None and parse_date(None) is None


def test_validation_is_source_aware():
    assert validate("", "t", "ar").status == "empty"
    assert validate("عنوان الخبر", "عنوان الخبر", "ar").reason == "title_only"
    short = "أعلنت الوزارة عن بدء التسجيل في البرنامج الجديد اعتباراً من الأحد المقبل عبر المنصة الإلكترونية الرسمية."
    assert validate(short, "x", "ar").status == "partial"
    assert validate(short, "x", "ar", min_chars=90).status == "complete"


def test_hashes_ignore_diacritics_and_spacing():
    a = "أطلقت الهيئةُ خدمةً جديدةً   اليوم"
    b = "اطلقت الهيئه خدمه جديده اليوم"
    assert content_hash(a) == content_hash(b)
    base = " ".join(f"كلمة{i}" for i in range(200))
    near = base.replace("كلمة150", "كلمة_معدلة")
    far = " ".join(f"نص{i}" for i in range(200))
    dist = lambda x, y: bin((simhash64(x) ^ simhash64(y)) & (2**64 - 1)).count("1")  # noqa: E731
    # Same threshold the API uses for near-duplicates (bit_count <= 3).
    assert dist(base, near) <= 3 < 16 < dist(base, far)


def test_clean_paragraphs_keeps_sentences_that_mention_sharing():
    paras = clean_paragraphs(["شارك", "شارك أكثر من 300 مستثمر في المؤتمر الذي عقد في الرياض يوم الاثنين.", "Share"])
    assert paras == ["شارك أكثر من 300 مستثمر في المؤتمر الذي عقد في الرياض يوم الاثنين."]


def test_text_in_div_nested_inside_p_is_kept():
    # Real pattern (aleqt.com): <div> inside <p>; the parser moves the text out of the <p>.
    html = ("<html><body><div class='article-content'><p class='article-text'><br></p><p class='article-text'><div> "
            + "أعلنت هيئة الأفلام السعودية عن اختيار الفيلم لتمثيل المملكة رسميًا في سباق الأوسكار المقبل عن فئة أفضل فيلم دولي. " * 3
            + "</div></p></div></body></html>").encode("utf-8")
    body = extract_body(parse_tree(html, "utf-8"), None, None)
    assert body.strategy == "known" and "سباق الأوسكار" in "\n".join(body.paragraphs)


def test_nextjs_generic_fallback_skips_config_scripts():
    from app.extract.sites.nextjs import flight_largest_row
    page = fixture_html("nextjs_flight.html").decode("utf-8")
    config_row = r'self.__next_f.push([1,"40:[\"$\",\"script\",null,{\"dangerouslySetInnerHTML\":{\"__html\":\"{\\\"adConfig\\\":{\\\"enabled\\\":true,\\\"x\\\":\\\"' + "a" * 900 + r'\\\"}}\"}}]\n"])'
    page = page.replace("</body>", f"<script>{config_row}</script></body>")
    text = "\n".join(flight_largest_row(page))
    assert "منصة إطلاق الصواريخ" in text and "adConfig" not in text


def test_html_entities_in_structured_titles_are_decoded():
    # Real case (saudigazette.com.sa): JSON-LD headline carried &#039; for an apostrophe.
    html_doc = ('<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"AI &#039;could&#039; end &amp;amp; begin",'
                '"author":{"name":"O&#039;Neil"}}</script></head><body></body></html>').encode("utf-8")
    meta = extract_metadata(Selector(content=html_doc, url="https://x.example/a", encoding="utf-8"), "https://x.example/a")
    assert meta["title"] == "AI 'could' end & begin" and meta["authors"] == ["O'Neil"]

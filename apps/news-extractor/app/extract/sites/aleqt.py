"""Economic publisher: observed visible Arabic date format, offline fixtures.

No network discovery or browser execution. The narrow post-headline text
window needs validation against a future approved saved HTML sample.
"""
from . import SiteRule, register

register(SiteRule(
    domains=("aleqt.com",), body=(".article-content",),
    date_xpath="(//h1/following::text()[not(ancestor::script) and not(ancestor::style) "
               "and not(ancestor::*[contains(concat(' ',normalize-space(@class),' '),' article-content ')])])[position() <= 20]",
    notes="Arabic full timestamp after headline; reject missing or ambiguous dates.",
))

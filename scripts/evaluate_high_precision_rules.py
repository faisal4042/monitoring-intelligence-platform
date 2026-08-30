import json
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd


sys.stdout.reconfigure(encoding="utf-8")


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).lower()
    value = re.sub(r"[إأآٱ]", "ا", value)
    value = value.replace("ى", "ي").replace("ؤ", "و").replace("ئ", "ي")
    value = re.sub(r"[ًٌٍَُِّْـ]", "", value)
    return re.sub(r"\s+", " ", value).strip()


RULES = {
    "ejar": {
        "handles": ["ejar_sa"],
        "phrases": ["منصة إيجار", "شبكة إيجار", "منصة ايجار", "شبكة ايجار"],
    },
    "rega": {
        "handles": ["rega_cares", "rega_ksa", "spokesprega", "sre_institute", "subdivision_sa", "rersaudi", "rersaudi_care"],
        "phrases": ["الهيئة العامة للعقار", "هيئة العقار", "المعهد العقاري السعودي", "منصة فرز الوحدات العقارية", "السجل العقاري"],
    },
    "mullak": {
        "handles": ["mullak_sa"],
        "phrases": ["منصة ملاك", "اتحاد الملاك", "جمعية الملاك"],
    },
    "mostadam": {
        "handles": ["mostadam_sa"],
        "phrases": ["منصة البناء المستدام", "منصة مستدام", "شهادة مستدام", "تقييم مستدام"],
    },
}

NEGATIVES = [
    "للبيع", "للإيجار", "للايجار", "مطلوب مستأجر", "مطلوب مستاجر",
    "شقة للإيجار", "شقه للايجار", "فيلا للإيجار", "فيلا للايجار",
    "أرض للإيجار", "ارض للايجار", "دور للإيجار", "دور للايجار",
    "استراحة للإيجار", "شاليه", "مخيم", "تأجير سيارات", "تاجير سيارات",
    "تمويل شخصي", "اعادة تمويل", "إعادة تمويل", "شراء مديونية", "تمويل اضافي",
    "تمويل إضافي", "نقاط بيع", "قرض شخصي", "للتواصل واتساب", "للتواصل خاص",
    "تواصل واتساب", "للطلب", "احجز الآن", "احجز الان", "عروض خاصة", "عرض خاص",
    "خصم", "كود خصم", "إعلان مدفوع", "اعلان مدفوع", "أسعار منافسة", "اسعار منافسه",
    "تداول", "فوركس", "كريبتو", "عملات رقمية", "عملات رقميه", "ربح مضمون",
    "إشارة تداول", "اشارة تداول", "توصيات الأسهم", "توصيات الاسهم", "usdt",
    "crypto", "forex", "stocks", "stockstobuy", "trading", "investing", "signal",
    "whatsapp", "million dollar", "password", "investment account",
    "خدمات الضيافة", "خدمات الضيافه", "القهوة السعودية", "القهوه السعوديه",
    "مطلوب مسوق", "مسوقه عقار", "مسوقة عقار", "تقديم العروض والطلبات",
]

source = Path(sys.argv[1])
frame = pd.read_excel(
    source,
    sheet_name="تحليل",
    usecols=["Topic/Profile", "Sub Media Type", "Message", "Classifications"],
)
frame = frame.fillna("")
frame = frame[frame["Sub Media Type"].astype(str).eq("Twitter Mentions")].copy()
frame["norm"] = frame["Message"].astype(str).map(normalize)
frame["noise"] = frame["Classifications"].astype(str).map(normalize).str.contains("اخري او اعلانات", regex=False)

negative_norm = [normalize(value) for value in NEGATIVES]
results = {}
for program, rule in RULES.items():
    handles = [handle.lower() for handle in rule["handles"]]
    phrases = [normalize(phrase) for phrase in rule["phrases"]]
    handle_pattern = re.compile(r"(?<![\w@])@(" + "|".join(map(re.escape, handles)) + r")\b", re.I)
    matched = frame[
        frame["Message"].astype(str).str.contains(handle_pattern, na=False)
        | frame["norm"].map(lambda text: any(phrase in text for phrase in phrases))
    ].copy()
    matched["blocked"] = matched["norm"].map(lambda text: any(term in text for term in negative_norm))
    kept = matched[~matched["blocked"]]
    false_kept = kept[kept["noise"]]
    true_kept = kept[~kept["noise"]]
    results[program] = {
        "handles": rule["handles"],
        "phrases": rule["phrases"],
        "matched_before_filter": len(matched),
        "blocked": int(matched["blocked"].sum()),
        "kept": len(kept),
        "historically_relevant": len(true_kept),
        "historically_noise": len(false_kept),
        "historical_precision": round(len(true_kept) / len(kept), 4) if len(kept) else None,
        "noise_samples": [re.sub(r"https?://\S+", "<URL>", text).replace("\n", " ")[:500]
                          for text in false_kept["Message"].head(30)],
    }

print(json.dumps({"public_mentions": len(frame), "negatives": NEGATIVES, "programs": results}, ensure_ascii=False, indent=2))

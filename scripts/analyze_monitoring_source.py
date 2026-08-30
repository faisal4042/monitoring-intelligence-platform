import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd


sys.stdout.reconfigure(encoding="utf-8")
source = Path(sys.argv[1])
output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
columns = [
    "Topic/Profile", "Ticket Type", "Media Type", "Sub Media Type", "Message",
    "User Name", "Screen name", "Classifications", "Classification1",
    "Classification2", "Classification3", "Link",
]
frame = pd.read_excel(source, sheet_name="تحليل", usecols=columns)
for column in columns:
    frame[column] = frame[column].fillna("").astype(str)

url_re = re.compile(r"https?://\S+", re.I)
mention_re = re.compile(r"(?<![\w@])@([A-Za-z0-9_]{1,15})")
hashtag_re = re.compile(r"(?<!\w)#([\w\u0600-\u06ff]+)")

topics = []
for topic, group in frame.groupby("Topic/Profile", sort=False):
    public = group[~group["Sub Media Type"].str.contains("DM", case=False, na=False)]
    messages = public["Message"] if len(public) else group["Message"]
    mentions = Counter(
        handle.lower() for text in messages for handle in mention_re.findall(text)
    )
    hashtags = Counter(
        tag for text in messages for tag in hashtag_re.findall(text)
    )
    classes = Counter(
        value.strip()
        for col in ["Classification1", "Classification2", "Classification3"]
        for value in group[col]
        if value.strip() and value.strip().lower() != "none"
    )
    samples = [url_re.sub("<URL>", value).replace("\n", " ")[:350]
               for value in messages.drop_duplicates().head(8)]
    screen_names = Counter(
        value.lower().lstrip("@").strip() for value in group["Screen name"]
        if value.strip()
    )
    topics.append({
        "topic": topic,
        "rows": len(group),
        "public_rows": len(public),
        "sub_media": group["Sub Media Type"].value_counts().head(10).to_dict(),
        "top_message_mentions": mentions.most_common(20),
        "top_hashtags": hashtags.most_common(20),
        "top_classifications": classes.most_common(25),
        "unique_screen_names": len(screen_names),
        "top_screen_names": screen_names.most_common(10),
        "samples": samples,
    })

overall = {
    "rows": len(frame),
    "topics_count": frame["Topic/Profile"].nunique(),
    "topics": sorted(topics, key=lambda item: item["rows"], reverse=True),
    "media": frame["Media Type"].value_counts().to_dict(),
    "sub_media": frame["Sub Media Type"].value_counts().to_dict(),
}
payload = json.dumps(overall, ensure_ascii=False, indent=2)
if output_path:
    output_path.write_text(payload, encoding="utf-8")
    print(json.dumps({
        "saved": str(output_path),
        "rows": overall["rows"],
        "topics": [
            {"topic": item["topic"], "rows": item["rows"], "public_rows": item["public_rows"]}
            for item in overall["topics"]
        ],
    }, ensure_ascii=False, indent=2))
else:
    print(payload)

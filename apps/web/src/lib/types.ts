export interface Post {
  id: string; x_post_id: string; x_author_id: string; text: string; posted_at: string; url: string;
  username: string | null; display_name: string | null; followers_count: number | null;
  profile_image_url: string | null; author_bio: string | null;
  is_verified: boolean | null; relevance: string | null; intent: string | null;
  reason_ar: string | null; stage: number | null; sentiment: string | null;
  program_name: string | null; program_color: string | null;
  topic_id: string | null; topic_name: string | null; is_influencer: boolean;
  media: Array<{ url: string | null; previewImageUrl: string | null; width: number | null; height: number | null; type: string }>;
  matched_keywords: string[] | null; status: string; filter_reason: string | null;
  duplicate_type: string | null;
  like_count: number | null; repost_count: number | null; reply_count: number | null;
}

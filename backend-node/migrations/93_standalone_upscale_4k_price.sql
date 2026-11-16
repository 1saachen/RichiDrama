-- Append the official 4K tiers to the existing official Volcengine price
-- item. Keep custom books, existing rates, and authorization snapshots intact.
UPDATE billing_price_book_items AS i
SET conditions_json = json_insert(i.conditions_json,
    '$.rates[#]', json('{"id":"4k_30","when":{"resolution_tier":"4k","fps_tier":"lte30"},"unit_price_points":2000,"unit_size":60000}'),
    '$.rates[#]', json('{"id":"4k_60","when":{"resolution_tier":"4k","fps_tier":"lte60"},"unit_price_points":4000,"unit_size":60000}'),
    '$.rates[#]', json('{"id":"4k_120","when":{"resolution_tier":"4k","fps_tier":"lte120"},"unit_price_points":8000,"unit_size":60000}'))
WHERE i.service_type = 'video_postprocess'
  AND i.model = 'volcengine-video-generative-enhancement'
  AND i.meter = 'millisecond'
  AND i.is_free = 0
  AND EXISTS (
    SELECT 1 FROM billing_price_books pb
    WHERE pb.id = i.price_book_id AND pb.provider = 'volcengine'
      AND pb.status = 'published' AND pb.owner_user_id IS NULL AND pb.system_managed = 1
  )
  AND json_extract(i.conditions_json, '$.pricing_note') =
    'Official AI MediaKit generative enhancement output-duration price, 100 points = CNY 1'
  AND json_type(i.conditions_json, '$.rates') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(i.conditions_json, '$.rates') rate
    WHERE json_extract(rate.value, '$.when.resolution_tier') = '4k'
  );

/**
 * Curated site-wide reviews shown on the storefront home page ONLY while there is not a single
 * approved general feedback in the database. The moment one real review is approved these
 * disappear entirely — same rule the product page already follows with admin seed reviews
 * (see AdminReviewController.getActiveForProduct).
 *
 * Edit the list below to change the copy; ids are synthetic strings so they can never collide
 * with a real feedback's numeric id, and every row carries `is_seed: true` so any client can
 * tell them apart from genuine customer feedback.
 */

const SITE_REVIEW_FALLBACK = [
  {
    name: 'Ritu Agarwal',
    rating: 5,
    comment:
      'Ordered a Katan silk saree for my sister\'s wedding and it arrived beautifully packed, exactly like the pictures. The zari work is stunning in person.',
    date: '2026-05-18',
  },
  {
    name: 'Meenakshi Iyer',
    rating: 5,
    comment:
      'What I liked most is how easy the website is to use. Filtering by fabric and colour saved me so much time, and delivery was quicker than promised.',
    date: '2026-05-29',
  },
  {
    name: 'Pooja Sharma',
    rating: 4,
    comment:
      'Genuine Banarasi weave at a fair price. I had a question about the border and the team replied on WhatsApp the same day. Very helpful people.',
    date: '2026-06-07',
  },
  {
    name: 'Anjali Verma',
    rating: 5,
    comment:
      'Second order from Banarasi Kala. Fabric quality is consistent and the saree colours are true to the photos on the site. Highly recommended.',
    date: '2026-06-21',
  },
  {
    name: 'Sneha Gupta',
    rating: 5,
    comment:
      'Smooth checkout, order tracking updates at every step and the saree reached me in three days. Feels like buying straight from Varanasi.',
    date: '2026-07-04',
  },
];

// Shaped exactly like a row from GET /feedback/approved so the storefront renders it with the
// same code path — no client-side special casing beyond the optional `is_seed` marker.
const getSiteReviewFallback = () =>
  SITE_REVIEW_FALLBACK.map((review, index) => ({
    id: `site-seed-${index + 1}`,
    rating: review.rating,
    title: null,
    comment: review.comment,
    images: [],
    product_id: null,
    order_id: null,
    Customer: { name: review.name },
    Product: null,
    created_at: review.date ? new Date(`${review.date}T00:00:00Z`).toISOString() : null,
    is_approved: true,
    is_seed: true,
  }));

module.exports = { getSiteReviewFallback };

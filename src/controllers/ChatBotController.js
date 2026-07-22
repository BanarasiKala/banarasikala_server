// Randomly pick one response from an array to keep replies feeling fresh
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const rules = [
  // ── Good morning ──
  {
    match: (t) => /\bgood\s*morning\b/i.test(t),
    reply: () =>
      pick([
        "Good morning! ☀️ Hope you're starting your day beautifully!\n\nI'm Kala, your Banarasi Kala assistant. Looking for something special today? I can help you with our saree collections, pricing, shipping, and more. What's on your mind?",
        "सुप्रभात! Good morning! 🌸\n\nWhat a lovely time to discover something beautiful. Can I help you explore our Banarasi silk collection, check an order, or answer any questions?",
        "Good morning! 🌺 May your day be as vibrant as a Banarasi silk saree!\n\nI'm here to help you. Ask me about our collections, offers, shipping, or anything else you'd like to know!",
      ]),
  },

  // ── Good afternoon ──
  {
    match: (t) => /\bgood\s*afternoon\b/i.test(t),
    reply: () =>
      pick([
        "Good afternoon! 🌤️ Great time to find your next favourite saree!\n\nI'm Kala, and I'm here to help. What are you looking for today — a new collection, order update, or something else?",
        "Good afternoon! ✨ Welcome to Banarasi Kala!\n\nHow can I make your afternoon better? Whether it's finding the perfect saree or answering questions about your order — I'm all yours!",
      ]),
  },

  // ── Good evening ──
  {
    match: (t) => /\bgood\s*evening\b/i.test(t),
    reply: () =>
      pick([
        "Good evening! 🌙 Welcome to Banarasi Kala!\n\nPerfect time to browse our silk collection. I'm Kala, your shopping assistant. How can I help you this evening?",
        "Good evening! 🌸 Nothing like a quiet evening to explore timeless Banarasi elegance!\n\nI'm here to help with collections, orders, shipping, returns — just ask away!",
      ]),
  },

  // ── Good night ──
  {
    match: (t) => /\bgood\s*night\b/i.test(t),
    reply: () =>
      "Good night! 🌙✨\n\nThank you for visiting Banarasi Kala! Sweet dreams. If you have any questions, feel free to come back anytime — I'm available 24/7. Have a restful night! 🙏",
  },

  // ── Namaste / Namaskar ──
  {
    match: (t) => /\b(namaste|namaskar|pranam|jai hind|sat sri akal)\b/i.test(t),
    reply: () =>
      pick([
        "नमस्ते! 🙏 Namaste! Welcome to Banarasi Kala!\n\nI'm Kala, your personal assistant. I'm delighted to help you explore our authentic Banarasi silk sarees. What can I do for you today?",
        "Namaste! 🙏 What a warm greeting!\n\nI'm Kala, here to help you find the perfect Banarasi saree, check your order, or answer any question. How may I assist you?",
      ]),
  },

  // ── Hi / Hello / Hey and other casual greetings ──
  {
    match: (t) => /^(hi+|hello+|hey+|helo|howdy|sup|what'?s up|yo\b|hiya|heya|greetings)/i.test(t.trim()),
    reply: () =>
      pick([
        "Hi there! 👋 Welcome to Banarasi Kala!\n\nI'm Kala, your personal shopping assistant. Ask me anything about our sarees, collections, pricing, shipping, or orders. What can I help you with today?",
        "Hello! 😊 So glad you're here!\n\nI'm Kala — I can help you discover authentic Banarasi silk sarees, track an order, learn about our offers, and much more. What would you like to know?",
        "Hey! 🌟 Welcome!\n\nI'm Kala, your Banarasi Kala assistant. Whether you're looking for a saree for a special occasion or just browsing — I'm here to help. What's on your mind?",
        "Hi! 🙏 Namaste and welcome to Banarasi Kala!\n\nI'm Kala. You can ask me about our saree collections, prices, shipping, returns, discounts, and more. How can I help?",
      ]),
  },

  // ── How are you / How's it going ──
  {
    match: (t) => /(how are you|how r u|how're you|how's it going|how do you do|you good|kaise ho|kaisa|kya haal)/i.test(t),
    reply: () =>
      pick([
        "I'm doing wonderfully, thank you for asking! 😊\n\nReady to help you find your dream Banarasi saree. What are you looking for today?",
        "I'm great, always happy to help! 🌸\n\nMore importantly — how are YOU? Is there something special you're shopping for today?",
        "Doing fantastic, thanks! ✨ Always excited when someone visits Banarasi Kala.\n\nWhat can I help you find today?",
      ]),
  },

  // ── What can you do / What do you do ──
  {
    match: (t) => /(what can you do|what do you do|how can you help|what are your features|what do you know|help me|i need help)/i.test(t),
    reply: () =>
      "Here's everything I can help you with:\n\n🛍️ Saree Collections — types, fabrics, occasions\n💰 Pricing — budgets and current offers\n📦 Shipping — delivery times and tracking\n🔄 Returns & Exchanges — policy and process\n💳 Payments — accepted methods and EMI\n🎁 Gifting — packaging and bulk orders\n🧵 Care Tips — how to maintain your saree\n✂️ Customization — blouse, colour, design\n📋 Order Tracking — status and updates\n📞 Contact Support — reach our team\n\nJust type your question and I'll answer right away! 😊",
  },

  // ── Are you a bot / Are you human ──
  {
    match: (t) => /(are you (a )?(bot|robot|ai|machine|real|human|person)|who are you|who made you|what are you)/i.test(t),
    reply: () =>
      pick([
        "I'm Kala — Banarasi Kala's virtual shopping assistant! 🤖✨\n\nWhile I'm not human, I'm trained to answer all your questions about our sarees, orders, and policies. For complex issues, our human support team at support@banarasikala.com is always available!\n\nSo, what can I help you with? 😊",
        "Great question! I'm Kala, an AI assistant created by Banarasi Kala to help you 24/7. 🛍️\n\nI may not be human, but I know everything about our sarees, policies, and services! What would you like to know?",
      ]),
  },

  // ── Saree types / collections ──
  {
    match: (t) => /(type|types|kind|kinds|variety|varieties|collection|which saree|what saree|banarasi silk|katan|organza|georgette|tissue|brocade|zari|shikargah|tanchoi|dupion|tussar)/i.test(t),
    reply: () =>
      "We offer a stunning range of authentic Banarasi sarees:\n\n🥻 Katan Silk — pure silk with a lustrous finish, classic choice\n🌸 Organza (Kora) — lightweight, crisp texture, perfect for summers\n💫 Georgette — soft & flowy, great for all-day wear\n✨ Tissue Silk — golden shimmer, looks ethereal in light\n🌟 Brocade (Zari) — heavy weaves with gold/silver motifs\n🦌 Shikargah — traditional hunting-scene prints, very regal\n🎨 Tanchoi — intricate satin weave with colorful patterns\n🍂 Tussar Silk — earthy, natural texture, eco-friendly\n\nNot sure which one suits you? Tell me the occasion and I'll suggest the best match! 😊",
  },

  // ── Wedding / bridal ──
  {
    match: (t) => /(wedding|bridal|bride|shaadi|vivah|nikah|engagement|trousseau|dulhan|dulha)/i.test(t),
    reply: () =>
      "Congratulations on the special occasion! 💍🥻\n\nFor weddings we recommend:\n\n👰 Katan Silk — the most traditional bridal Banarasi, deeply rich\n✨ Heavy Brocade — gold zari work, stunning for the big day\n🌟 Tissue Silk — shimmers beautifully in wedding lights\n🎀 Shikargah — a timeless regal choice for brides\n\nWe also offer:\n• Saree sets with matching blouse piece\n• Trousseau packs (sets of 5, 7, 11 sarees)\n• Custom colour combinations\n• Special bridal packaging with gift box\n\nShare your budget and preferred colours and I'll find you the perfect bridal saree! 💕",
  },

  // ── Occasion ──
  {
    match: (t) => /(occasion|festival|puja|diwali|navratri|durga|eid|christmas|party|function|ceremony|casual|office|daily)/i.test(t),
    reply: () =>
      "Great question! Here's what we recommend by occasion:\n\n🎉 Festivals (Diwali, Navratri) — Tissue Silk, Brocade, vibrant Georgette\n🙏 Pujas & Ceremonies — Katan Silk, Shikargah in auspicious reds & yellows\n💼 Office / Daily Wear — lightweight Georgette or Organza\n🎊 Parties & Functions — Tanchoi, embroidered Georgette\n💍 Wedding / Bridal — Heavy Katan Silk or Zari Brocade\n\nTell me the occasion and your preferred colour and I'll suggest the perfect saree! 🥻",
  },

  // ── Colour queries ──
  {
    match: (t) => /(colour|color|red|pink|blue|green|yellow|white|black|maroon|gold|beige|cream|purple|orange|shade)/i.test(t),
    reply: () =>
      "We have Banarasi sarees in a gorgeous palette! 🎨\n\nPopular choices:\n🔴 Red & Maroon — bridal favourites, very traditional\n💛 Yellow & Gold — festive, Navratri special\n💚 Green — wedding season classic\n🩷 Pink — from soft blush to deep magenta\n🤍 White & Cream — elegant, for all occasions\n💜 Purple — royal and sophisticated\n🔵 Blue — from sky blue to deep navy\n\nOur full colour range is available on the website. You can also filter by colour in our collection page. Need a specific shade? Let me know! 😊",
  },

  // ── Price / budget ──
  {
    match: (t) => /(price|cost|rate|how much|budget|affordable|expensive|cheap|pricing|₹|rs\.?|rupee|value|worth)/i.test(t),
    reply: () =>
      "Our Banarasi sarees suit every budget:\n\n💚 ₹2,500 – ₹5,000 — Georgette, Organza (great starter range)\n💛 ₹5,000 – ₹12,000 — Katan Silk, Tanchoi\n🔴 ₹12,000 – ₹25,000 — Pure Silk Brocade, Tissue Silk\n👑 ₹25,000+ — Heavy Zari Brocade, Premium Bridal\n\n🎉 First-time buyers get 10% off with code WELCOME10!\n📩 Subscribe to our newsletter for exclusive sale alerts.\n\nWhat's your budget? I'll find the best saree for you! 😊",
  },

  // ── Shipping / delivery ──
  {
    match: (t) => /(ship|deliver|delivery|dispatch|courier|when will|how long|days|arrive|arrival|pincode|cod|cash on delivery|free ship)/i.test(t),
    reply: () =>
      "Here's everything about shipping:\n\n📦 Standard Delivery — 5–7 business days\n🚀 Express Delivery — 2–3 business days (select pincodes)\n🆓 Free shipping on orders above ₹999\n🏠 Cash on Delivery available on select orders\n⚡ Dispatched within 24 hours of order placement\n📲 Tracking link sent via SMS & email after dispatch\n\nWe ship across India via trusted couriers (Delhivery, Blue Dart, Shiprocket).\n\nWant to check if your pincode is serviceable? Visit our website or contact support! 🚚",
  },

  // ── Return / exchange ──
  {
    match: (t) => /(return|exchange|replace|wrong item|wrong size|defect|damage|not as describe|size guide|size chart)/i.test(t),
    reply: () =>
      "Our hassle-free Return & Exchange Policy:\n\n✅ 7-day return window from date of delivery\n✅ Easy exchange for size or colour mismatch\n✅ Free pickup for defective or wrong items\n✅ No questions asked for manufacturing defects\n✅ Replacement or full refund — your choice\n\n❌ Stitched or customized sarees are non-returnable\n❌ Items must be unused, in original packaging\n\nTo start a return:\n1. Go to My Orders\n2. Select your order\n3. Click 'Request Return'\n\nOr email support@banarasikala.com. Our team responds within 4 hours! 😊",
  },

  // ── Refund / cancel ──
  {
    match: (t) => /(refund|money back|when refund|refund status|cancel order|cancellation|cancel)/i.test(t),
    reply: () =>
      "Refund & Cancellation — quick and easy:\n\n💳 Refund processed in 5–7 business days\n🏦 Credited to your original payment method\n❌ Cancel any order before it's dispatched\n🔄 COD order refunds via bank transfer\n\nTo cancel:\n• Go to My Orders → Select Order → Cancel\n• Or email support@banarasikala.com\n\nFor refund status, check your email or contact our support team. We're here to help! 🙏",
  },

  // ── Order tracking ──
  {
    match: (t) => /(track|order status|where is my order|shipment status|tracking|my order|order id|shipped)/i.test(t),
    reply: () =>
      "Track your order in 3 easy steps:\n\n1️⃣ Log in to your Banarasi Kala account\n2️⃣ Click 'My Orders' in the top menu\n3️⃣ Select your order to see live tracking\n\nYou'll also receive:\n📲 SMS update with tracking link\n📧 Email notification at every stage\n\nHaven't received your tracking details? Email us your Order ID at support@banarasikala.com and we'll sort it out within 2 hours! 📦",
  },

  // ── Payment ──
  {
    match: (t) => /(payment|pay|upi|gpay|google pay|phonepe|paytm|visa|mastercard|rupay|card|wallet|emi|net banking|how to pay|razorpay)/i.test(t),
    reply: () =>
      "We accept all popular payment methods:\n\n💳 Cards — Visa, Mastercard, RuPay (debit & credit)\n📱 UPI — Google Pay, PhonePe, Paytm, BHIM\n🏦 Net Banking — all major Indian banks\n💰 Cash on Delivery — select locations\n👛 Wallet — Paytm Wallet, Amazon Pay\n🔒 All payments 100% secured by Razorpay\n\n📅 EMI available on orders above ₹3,000\n(Bajaj Finserv, Snapmint, HDFC, ICICI EMI)\n\nHaving trouble with payment? Contact us at support@banarasikala.com 🙏",
  },

  // ── Discount / offers ──
  {
    match: (t) => /(discount|offer|coupon|promo|code|sale|deal|voucher|off|cashback|festive|season)/i.test(t),
    reply: () =>
      "We love rewarding our customers! 🎉\n\n🎁 WELCOME10 — 10% off for first-time buyers\n🎊 Festive offers — check homepage for Diwali, Navratri, EID specials\n📧 Newsletter subscribers get early access to sales\n👥 Refer a friend — earn ₹100 wallet credits each\n💰 Wallet credits — redeemable on every order\n\nPro tip: Subscribe to our newsletter (in the footer) to never miss a deal! New offers every week. 😊\n\nShall I help you find the best deal for your budget?",
  },

  // ── Saree care ──
  {
    match: (t) => /(care|wash|clean|maintenance|preserve|store|storage|how to maintain|iron|dry)/i.test(t),
    reply: () =>
      "Expert Saree Care Tips from our weavers:\n\n🧺 Dry clean recommended for Katan Silk & Brocade\n💧 Georgette — gentle hand wash with mild detergent\n🌿 Always air dry in shade, never wring\n📦 Store in soft muslin cloth (not plastic bags)\n🚫 Avoid direct perfume or deodorant contact on fabric\n☀️ No prolonged sun exposure — fades the zari\n🌡️ Iron on medium heat with a cloth layer on top\n🪡 Re-starch lightly for a crisp drape\n\nWith proper care, a Banarasi saree can last for generations and even become a family heirloom! 🏺",
  },

  // ── Customization ──
  {
    match: (t) => /(custom|customiz|personaliz|bespoke|tailor|stitch|blouse|design|custom order|special order)/i.test(t),
    reply: () =>
      "Yes, we love creating something personal! 🎨\n\nOur customization options:\n✂️ Custom colour combinations on select weaves\n🪡 Personalized blouse piece (matching/contrasting)\n💍 Bridal trousseau sets (5, 7, or 11 sarees)\n🏢 Bulk/wholesale orders for events & corporates\n🎁 Custom gifting packages with personalized notes\n\nTo place a custom order:\n📧 Email: support@banarasikala.com\n📸 Instagram: @banarasikala_\n\nShare your idea, occasion, budget, and preferred colours — our team will respond within 24 hours! 🌟",
  },

  // ── Gifting / packaging ──
  {
    match: (t) => /(gift|gifting|wrap|packaging|present|surprise|special pack|for someone)/i.test(t),
    reply: () =>
      "Banarasi Kala sarees — the most thoughtful gift ever! 🎁\n\nEvery saree comes beautifully packaged with:\n🎀 Elegant gift box with golden ribbon\n🧵 Traditional fabric wrapping\n💌 Personalized gift note (add in order notes)\n\nSpecial gifting options:\n🏢 Corporate gifting — bulk orders with branding\n💍 Wedding gifting — trousseau sets for the bride's family\n🎊 Festive hampers — saree + accessories bundle\n\nFor bulk orders (10+ sarees), email support@banarasikala.com for special pricing! 😊",
  },

  // ── About / brand story ──
  {
    match: (t) => /(about|story|brand|company|banarasi kala|founded|history|varanasi|banaras|benares|heritage|weaver|artisan)/i.test(t),
    reply: () =>
      "The story of Banarasi Kala 🏛️\n\nWe are a heritage brand rooted in Varanasi (Banaras), India — the 3,000-year-old capital of Banarasi silk weaving.\n\n🧵 We work directly with master weavers in Varanasi\n🎨 Every saree is handcrafted using age-old techniques\n🌍 Our mission: bring authentic, weaver-direct sarees to every home\n💚 Every purchase directly supports a weaver family\n\nWe believe in:\n• Zero middlemen — best prices for you\n• Fair wages for artisans\n• Preserving India's most precious textile heritage\n\nRead our full story on the About Us page! 🙏",
  },

  // ── Contact / support ──
  {
    match: (t) => /(contact|whatsapp|phone|call|email|support|help|human|agent|speak|talk|reach|complaint)/i.test(t),
    reply: () =>
      "Our support team is always here for you! 💬\n\n📧 Email: support@banarasikala.com\n📍 Location: Varanasi, Uttar Pradesh, India\n🕐 Hours: Monday–Saturday, 10 AM – 7 PM IST\n⚡ Average response time: 2–4 hours\n\nYou can also:\n• Use the Contact Us page on our website\n• Message us on Instagram @banarasikala_\n• Leave a message here and I'll pass it along!\n\nIs there anything specific I can help you resolve right now? 🙏",
  },

  // ── Account / login ──
  {
    match: (t) => /(account|login|sign up|register|password|forgot|profile|log in|signup)/i.test(t),
    reply: () =>
      "Account help — quick and easy:\n\n👤 Sign Up — click 'Register' in the top navigation\n🎁 New users get ₹100 wallet credits on signup!\n🔑 Forgot Password — click 'Forgot Password' on login page\n📋 View orders, wishlist, and profile in 'My Account'\n🔐 All your data is secured and never shared\n\nFacing a login issue? Email support@banarasikala.com with your registered email and we'll help right away! 😊",
  },

  // ── Wishlist ──
  {
    match: (t) => /(wishlist|save|favourite|favorite|later|bookmark|liked|heart)/i.test(t),
    reply: () =>
      "Your Wishlist — never lose a saree you love! ❤️\n\n• Click the heart ❤️ on any saree to save it\n• Log in to sync your wishlist across devices\n• Get notified when a wishlisted item goes on sale\n• Share your wishlist with family before gifting season!\n\nAccess your wishlist from the top navigation bar anytime. 😊",
  },

  // ── New arrivals / latest ──
  {
    match: (t) => /(new arrival|new collection|latest|new in|just launched|fresh|recently added|what's new|trending)/i.test(t),
    reply: () =>
      "We launch new Banarasi sarees every week! 🆕\n\n✨ Check the 'New Arrivals' section on our homepage\n📧 Subscribe to our newsletter for launch alerts\n📸 Follow @banarasikala_ on Instagram for sneak peeks\n\nCurrent trending styles:\n🔥 Pastel Katan Silk — soft tones, huge demand\n🔥 Ombre Georgette — gradient dye, very contemporary\n🔥 Floral Brocade — classic motifs in fresh colours\n\nHead to /collection and sort by 'New Arrivals' to see the latest! 🌸",
  },

  // ── Thank you ──
  {
    match: (t) => /\b(thank|thanks|thank you|thx|thnx|ty|dhanyavad|shukriya)\b/i.test(t),
    reply: () =>
      pick([
        "You're most welcome! 🙏 It's my pleasure to help.\n\nIs there anything else I can assist you with? Happy shopping at Banarasi Kala — where every saree tells a beautiful story! 🥻",
        "Aww, thank you for the kind words! 😊🙏\n\nFeel free to come back anytime with more questions. Wishing you a wonderful shopping experience at Banarasi Kala!",
        "My pleasure! 🌸 That's what I'm here for.\n\nAnything else you'd like to know? I'm happy to help! 🙏",
      ]),
  },

  // ── Great / Awesome / Nice ──
  {
    match: (t) => /\b(great|awesome|amazing|wonderful|excellent|perfect|superb|nice|good|cool|wow|brilliant|fantastic|lovely|beautiful)\b/i.test(t),
    reply: () =>
      pick([
        "Thank you so much! 😊🌟 That makes me happy!\n\nAnything else I can help you with today?",
        "Glad to hear that! 🎉 Is there anything else you'd like to explore — sarees, offers, or order info?",
        "Wonderful! ✨ You're making my day!\n\nLet me know if there's anything else I can help you find. Happy shopping! 🥻",
      ]),
  },

  // ── Yes / Sure / Okay ──
  {
    match: (t) => /^(yes|yeah|yep|yup|sure|okay|ok|alright|absolutely|definitely|of course|go ahead|please do|haan|ji)\b/i.test(t.trim()),
    reply: () =>
      pick([
        "Great! 😊 Please go ahead — what would you like to know?",
        "Sure! Feel free to ask anything — I'm all ears! 👂",
        "Absolutely! What's your question? I'm ready to help! 🌟",
      ]),
  },

  // ── No / Not really ──
  {
    match: (t) => /^(no|nope|nah|not really|nothing|never mind|nvm|na|nahi)\b/i.test(t.trim()),
    reply: () =>
      pick([
        "No problem at all! 😊 Come back anytime you need help. Have a wonderful day! 🙏",
        "Alright! Feel free to ask if anything comes to mind later. Happy shopping! 🥻",
        "That's perfectly fine! 🌸 I'm here whenever you need me. Take care! 🙏",
      ]),
  },

  // ── Bye / goodbye ──
  {
    match: (t) => /\b(bye|goodbye|see you|see ya|later|cya|take care|alvida|phir milenge|good day)\b/i.test(t),
    reply: () =>
      pick([
        "Goodbye! 🙏 Thank you for visiting Banarasi Kala!\n\nHope to see you again soon. Wishing you a beautiful day! 🌸",
        "Take care! 😊 It was lovely chatting with you.\n\nCome back anytime — we're always here for you at Banarasi Kala! 🥻",
        "Goodbye! ✨ Remember, we're just a message away whenever you need us.\n\nHappy shopping, and have a wonderful day! 🙏",
      ]),
  },
];

const FALLBACK_REPLIES = [
  "Hmm, I'm not sure I understood that perfectly. 🤔\n\nCould you rephrase? Or try asking about:\n• Saree collections & types\n• Pricing & budget\n• Shipping & delivery\n• Returns & refunds\n• Order tracking\n• Discounts & offers\n• Care tips\n• Contact support",
  "I want to give you the right answer, but I didn't quite catch that! 😊\n\nYou can ask me things like:\n• 'What types of sarees do you have?'\n• 'How long does delivery take?'\n• 'What is your return policy?'\n• 'Do you have any discounts?'\n\nWhat would you like to know?",
  "I'm still learning, and that one stumped me! 🙈\n\nCould you try asking in a different way? I'm great at answering questions about our sarees, shipping, returns, orders, and more. Give it another try! 😊",
];

// ── The original rule-based bot, kept as the fallback ─────────────────────────────────────
// Serves every request when ANTHROPIC_API_KEY is unset, and any request where the Claude call
// fails (outage, rate limit, bad key). A degraded assistant beats a dead one, and this one is
// already written and already correct about the policies.
const ruleBasedReply = (userMessage) => {
  const matched = rules.find((rule) => rule.match(userMessage));
  return matched ? matched.reply(userMessage) : pick(FALLBACK_REPLIES);
};

// ── Free-tier short-circuit ───────────────────────────────────────────────────────────────
// Questions whose correct answer is FIXED TEXT — no catalogue lookup, no account access, no
// judgement. The rules engine already answers these correctly and costs nothing, so calling
// Claude for them is pure spend. Typically 30-50% of chat traffic is this kind of filler.
//
// DELIBERATELY NARROW. The rules array also matches "price", "colour", "types", "wedding",
// "new arrivals", "track my order" — but those need LIVE data (stock, prices) or the
// customer's own orders, and answering them from a canned string would be a downgrade, not a
// saving. Those must reach Claude and its tools.
//
// The bar for adding a pattern here: would the ideal answer be identical for every customer,
// on every day, regardless of what is in stock? If not, it does not belong.
const STATIC_INTENTS = [
  /^(hi+|hello+|hey+|helo|howdy|yo|hiya|heya|greetings)[\s!.?]*$/i,
  /\bgood\s*(morning|afternoon|evening|night)\b/i,
  /\b(namaste|namaskar|pranam|sat sri akal)\b/i,
  /(how are you|how r u|how's it going|kaise ho|kya haal)/i,
  /(are you (a )?(bot|robot|ai|machine|real|human)|who are you|who made you)/i,
  /\b(thank|thanks|thank you|thx|dhanyavad|shukriya)\b/i,
  // Brand story, contact details, payment methods, care instructions, account help:
  // all fixed text that never depends on the catalogue.
  /(about (the )?(brand|company|you)|your story|who is banarasi kala|brand story)/i,
  /(contact|whatsapp number|phone number|email address|customer care|speak to (a )?human)/i,
  /(payment (method|option)s?|which payments|do you accept (upi|card)|how (do|can) i pay)/i,
  /(care instruction|how (to|do i) (wash|clean|store|iron|maintain)|washing instruction)/i,
  /(forgot password|reset password|how (do|to) (i )?(login|log in|sign ?up|register))/i,
];

// A static-intent message must ALSO match a real rule — otherwise the rules engine would just
// emit a random "I didn't understand" fallback, and Claude would have answered properly.
const staticReplyFor = (userMessage) => {
  const text = String(userMessage || '');
  if (!STATIC_INTENTS.some((pattern) => pattern.test(text))) return null;
  const matched = rules.find((rule) => rule.match(text));
  return matched ? matched.reply(text) : null;
};

const AiChatService = require("../services/AiChatService");
const ChatConversation = require("../models/ChatConversation");
const ChatMessage = require("../models/ChatMessage");
const { config } = require("../config/env");
const { Op } = require("sequelize");

// Global schema sync is off in this project, so the chat tables are created on first use —
// the same pattern as ensureOrderItemActionSchema.
let chatSchemaReady = false;
const ensureChatSchema = async () => {
  if (chatSchemaReady) return;
  await ChatConversation.sync();
  await ChatMessage.sync();
  chatSchemaReady = true;
};

// ── SSE ───────────────────────────────────────────────────────────────────────────────────
const sse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
};

/**
 * Rebuild the model's view of the conversation from the DB.
 *
 * Only the last N turns are replayed. The DB keeps everything; the model sees a window —
 * otherwise input tokens grow with every message and a long chat costs quadratically.
 *
 * Public tool calls are replayed as real tool_use/tool_result pairs so the model can still
 * answer "tell me about the second one". Account tool calls are replayed as the assistant's
 * TEXT ONLY: we never stored their results, and a tool_use block without a matching
 * tool_result is an API error — so the block is dropped along with the PII it saw.
 */
const buildReplay = (rows) => {
  const messages = [];

  for (const row of rows) {
    if (row.role === "user") {
      messages.push({ role: "user", content: row.content || "" });
      continue;
    }

    const results = Array.isArray(row.tool_results) ? row.tool_results : [];
    const replayableIds = new Set(results.map((r) => r.tool_use_id));
    const calls = (Array.isArray(row.tool_calls) ? row.tool_calls : [])
      .filter((call) => call.id && replayableIds.has(call.id)); // public calls only

    const content = [];
    if (row.content) content.push({ type: "text", text: row.content });
    for (const call of calls) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input || {} });
    }
    if (!content.length) continue;

    messages.push({ role: "assistant", content });

    // Every tool_use must be answered by a tool_result in the very next user turn.
    if (calls.length) {
      messages.push({
        role: "user",
        content: calls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: results.find((r) => r.tool_use_id === call.id)?.content || "{}",
        })),
      });
    }
  }

  // The API requires the first message to be from the user.
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
};

exports.message = async (req, res) => {
  const userMessage = String(req.body.message || "").trim();
  if (!userMessage) {
    return res.status(400).json({ reply: "Please type something so I can help you! 😊" });
  }
  if (userMessage.length > 1000) {
    return res.status(400).json({ reply: "That's a bit long for me — could you shorten it?" });
  }

  // The identity comes from the JWT (optionalAuthMiddleware), never from the request body.
  const customerId = req.userRole === "customer" ? req.user?.id || null : null;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // don't let nginx buffer the stream
  res.flushHeaders?.();

  // The client shows the typing dots until the first text delta lands. Emitted here rather than
  // sniffed off the stream: with thinking display defaulting to "omitted", the thinking blocks
  // arrive with empty text and are not a reliable signal.
  sse(res, "thinking", {});

  const degrade = (conversationId) => {
    sse(res, "text", { delta: ruleBasedReply(userMessage) });
    sse(res, "done", { chat_id: conversationId || null, degraded: true });
    res.end();
  };

  if (!AiChatService.isEnabled()) return degrade(null);

  let conversation = null;
  try {
    await ensureChatSchema();

    // ── Free-tier short-circuit ─────────────────────────────────────────────────────────
    // "hi", "thanks", "what payment methods do you take" — fixed answers that need no
    // catalogue lookup and no account access. The rules engine handles them for ₹0, so
    // spending an API call is pure waste. Still persisted, so the analytics and the
    // conversation history stay complete.
    //
    // Only short-circuits on the FIRST message of a conversation. Mid-conversation, a bare
    // "thanks" may be a reply to something Claude just said, and a canned greeting would be
    // a non-sequitur — let the model keep the thread.
    const isFirstMessage = !String(req.body.chat_id || "").trim();
    const staticReply = isFirstMessage ? staticReplyFor(userMessage) : null;
    if (staticReply) {
      const convo = await ChatConversation.create({ customer_id: customerId });
      await ChatMessage.bulkCreate([
        { conversation_id: convo.id, role: "user", content: userMessage },
        { conversation_id: convo.id, role: "assistant", content: staticReply },
      ]);
      await convo.update({ last_message_at: new Date() });
      sse(res, "text", { delta: staticReply });
      sse(res, "done", { chat_id: convo.id });
      return res.end();
    }

    // ── Resolve the conversation ────────────────────────────────────────────────────────
    const requestedId = String(req.body.chat_id || "").trim() || null;
    if (requestedId) {
      conversation = await ChatConversation.findByPk(requestedId);
      // Someone else's conversation (guessed UUID), or one that started anonymous and is now
      // being claimed by a signed-in user. Either way, don't touch it — start fresh.
      if (conversation && (conversation.customer_id || null) !== customerId) conversation = null;
    }
    if (!conversation) {
      conversation = await ChatConversation.create({ customer_id: customerId });
    }

    const history = await ChatMessage.findAll({
      where: { conversation_id: conversation.id },
      order: [["id", "DESC"]],
      limit: config.aiChatReplayTurns * 2, // a "turn" is a user message plus a reply
    });
    const messages = buildReplay(history.reverse());
    messages.push({ role: "user", content: userMessage });

    await ChatMessage.create({
      conversation_id: conversation.id,
      role: "user",
      content: userMessage,
    });

    // ── Run the turn ────────────────────────────────────────────────────────────────────
    const turn = await AiChatService.runTurn({
      messages,
      customerId,
      onText: (delta) => sse(res, "text", { delta }),
      onToolResult: (name, input, result) => {
        // Product CARDS are rendered from the tool result, not from Claude's prose. The model
        // describes; React renders. That way a price can never be hallucinated into the DOM.
        const products = result?.products || (result?.product_id ? [result] : null);
        if (products?.length) sse(res, "products", { products });
        if (name === "add_to_cart" && result?.added) sse(res, "cart_updated", {});
      },
    });

    await ChatMessage.create({
      conversation_id: conversation.id,
      role: "assistant",
      content: turn.text,
      tool_calls: turn.toolCalls.length ? turn.toolCalls : null,
      tool_results: turn.toolResults.length ? turn.toolResults : null,
    });

    await conversation.update({
      input_tokens: conversation.input_tokens + turn.usage.input_tokens,
      output_tokens: conversation.output_tokens + turn.usage.output_tokens,
      cache_read_tokens: conversation.cache_read_tokens + turn.usage.cache_read_input_tokens,
      message_count: conversation.message_count + 2,
      last_message_at: new Date(),
      escalated: conversation.escalated || /support@banarasikala\.com/i.test(turn.text),
    });

    sse(res, "done", { chat_id: conversation.id });
    return res.end();
  } catch (error) {
    console.error("[ChatBot] AI turn failed:", error?.message || error);
    // Outage, rate limit, bad key — serve the rule-based reply rather than a dead chat.
    if (res.writableEnded) return undefined;
    return degrade(conversation?.id);
  }
};

/**
 * Delete transcripts past the retention window (default 90 days).
 *
 * A chat log is a PII store the day a signed-in customer uses it. Keeping it forever is a
 * liability with no owner; call this from a daily cron.
 */
exports.purgeOldConversations = async () => {
  await ensureChatSchema();
  const cutoff = new Date(Date.now() - config.aiChatRetentionDays * 24 * 60 * 60 * 1000);
  const stale = await ChatConversation.findAll({
    where: { created_at: { [Op.lt]: cutoff } },
    attributes: ["id"],
  });
  if (!stale.length) return 0;
  const ids = stale.map((row) => row.id);
  await ChatMessage.destroy({ where: { conversation_id: { [Op.in]: ids } } });
  await ChatConversation.destroy({ where: { id: { [Op.in]: ids } } });
  console.log(`[ChatBot] purged ${ids.length} conversation(s) older than ${config.aiChatRetentionDays} days.`);
  return ids.length;
};

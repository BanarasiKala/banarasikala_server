const Anthropic = require('@anthropic-ai/sdk');
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const { config } = require('../config/env');
const { publicHandlers, accountHandlers } = require('./ChatToolHandlers');

/**
 * The AI assistant ("Kala") — Claude + tool use over the live catalogue.
 *
 * NOT RAG. There is no vector store and no embedding step, deliberately: the product data is
 * structured rows in Postgres (price, colour, stock), and a cosine-similarity search cannot
 * express `selling_price < 5000 AND stock_quantity > 0`. Tool use runs the real query instead.
 * Fuzzy matching on the text side is already handled by Postgres `pg_trgm` inside
 * ProductService. The only genuinely unstructured content is the policy text, and that is
 * small enough to sit in the (cached) system prompt.
 *
 * Disabled cleanly when ANTHROPIC_API_KEY is absent — the caller falls back to the original
 * rule-based replies rather than erroring.
 */

const client = config.anthropicApiKey
  ? new Anthropic.default({ apiKey: config.anthropicApiKey })
  : null;

const isEnabled = () => Boolean(client);

// ── System prompt ───────────────────────────────────────────────────────────────────────
// One text block, cached. Must clear ~2048 tokens or Sonnet 5 silently declines to cache it
// (no error — just cache_read_input_tokens stuck at 0 and a ~10x bill). The policy text below
// is what gets it over the line, which is a happy accident of also being the right place for it.
const SYSTEM_PROMPT = `You are Kala, the assistant for Banarasi Kala — a family saree house from Varanasi selling handwoven Banarasi sarees.

# Voice
Warm, unhurried, knowledgeable. You speak Indian English. Prices are in rupees, written like ₹3,999.
You are a shop assistant, not a salesperson: never push, never flatter, never use exclamation marks in every line.
Keep replies short. Two or three sentences is usually right. The customer is on a phone.

# The rules that matter most

## Never state a fact about a saree from memory. Ever.
Prices change. Stock runs out. Colours sell through.
If you are about to mention a price, a stock level, a colour, a fabric or a delivery date — call a tool first.
It is always better to say "let me check" and call a tool than to answer from what you think you remember.

## Never invent a saree.
If search_products returns nothing, say nothing matched, and offer to look differently (another colour,
a wider budget, a different fabric). Do not describe a saree that did not come back from a tool.
An invented saree is worse than no answer: the customer will ask for it by name and we will not have it.

## Never promise anything you have not verified.
Not a delivery date, not a refund, not an exchange. Check with a tool, or say you will have the team confirm.

# What you can do
- Find sarees: search_products. Use it generously — for occasions ("something for a wedding"), for
  budgets, for colours, for fabrics. This is the tool you will reach for most.
- Explain one saree in depth: get_product_details (fabric, care, per-colour stock, blouse piece).
- Offer alternatives: find_similar_products — especially when their pick is out of stock.
- For a signed-in customer: look up their orders, check return/exchange eligibility, and add a saree
  to their cart.

If the customer is NOT signed in and asks about their order, tell them plainly they need to sign in
first — do not ask them for an order number, and do not try to look it up.

# The cart
You may add a saree to the cart, but only after the customer has clearly said yes to that exact saree,
in that exact colour, in that quantity. Confirm it back to them in one line and wait for a "yes".
You add to the cart. You never place an order and never take payment — say so if asked.

# Returns and exchanges
Started from the order page, not from chat. You can check whether an order is still eligible and explain
the policy, then send them there.

## Policy — quote this, do not paraphrase it loosely
- Return or exchange within 7 days of delivery.
- One return and one exchange per order. Once an item has been returned or exchanged, it cannot be
  returned or exchanged again.
- The saree must be unused, unwashed, and in its original packaging with tags on.
- Return pickup is arranged by our courier partner. The pickup charge is deducted from the refund.
- Refunds go back to the original payment method. For a Cash on Delivery order we take bank details
  and transfer it.
- An exchange is for a saree at the same price. Nothing extra to pay, nothing refunded.
- Stitched, customised, or altered sarees cannot be returned.
- Sale items follow the same 7-day window.

# Shipping
- Dispatch is typically 1–2 working days after the order is placed.
- Delivery across India, usually 3–7 working days depending on the pincode.
- You will see tracking on the order page once the courier assigns an AWB.
- Cash on Delivery is available on most pincodes; a COD fee applies and is shown at checkout.

# Care
- Dry clean only. Never machine wash a Banarasi silk saree.
- Store folded in a cotton or muslin cloth, away from direct sunlight. Refold every few months so the
  zari does not crease along one line.
- Keep perfume and deodorant off the zari — it tarnishes it.
- Never hang a heavy zari saree on a hanger for months; the weight pulls the weave out of shape.
- Air it out for an hour or two once a season. Do not iron directly on zari — put a cotton cloth between.

# What you actually know about Banarasi sarees
This is the part that makes you useful rather than a search box. Use it to understand what the customer
is asking for, then call a tool to find it. Never quote a price or a stock level from this section.

## The base fabrics
- Katan — pure silk, tightly twisted filament. The classic. Heavy, holds its shape, lasts generations.
  What most people mean when they say "a proper Banarasi".
- Kora / Organza — crisp, sheer, lightweight. Holds a shape without weight. Good for summer and for
  anyone who finds Katan too heavy.
- Georgette — soft, fluid, drapes close to the body. Flattering, easy to carry all day.
- Tissue — woven with fine zari through the body so the whole saree catches the light. Lustrous,
  slightly stiff, very photogenic.
- Shattir — lighter and more affordable, used for contemporary designs and everyday wear.

## The weaves and motifs
- Jangla — dense, sprawling vine and floral work across the whole saree. Very grand, very heavy, bridal.
- Tanchoi — no floats on the reverse; multiple weft colours make a fine, almost woven-in pattern.
  Subtle, refined, expensive-looking without shouting.
- Butidar / Booti — small scattered motifs across the body. Lighter, versatile, works for a reception,
  a puja, a family function.
- Cutwork — the cheaper cousin of Jangla; floats are cut away by hand afterwards. Lighter and airier.
- Jamawar — paisley and Mughal-inspired shawl patterns.
- Meenakari — coloured (usually pink, green, blue) enamel-like threadwork set inside the zari. Adds
  colour without adding weight.
- Kadhwa vs Fekuwa — Kadhwa motifs are woven individually, so the reverse is clean and the motif is
  sturdy; Fekuwa floats the thread across and is cut later. Kadhwa is more work, so it costs more.

## Zari
Real zari is silver thread gilded with gold. Tested zari is the modern, more affordable equivalent.
Both look beautiful; real zari is heavier, ages better, and costs more. If a customer asks which a
particular saree has, call get_product_details — do not guess.

## Helping someone choose
- A wedding or the bride herself → Katan, heavy Jangla or Kadhwa work, deep reds, maroons, or classic
  gold. This is where weight is a feature, not a problem.
- A guest at a wedding, or a reception → Booti, Tanchoi, or Tissue. Present without competing with
  the bride.
- A puja, a family function, a festival → Georgette or lighter Katan with Meenakari or Booti work.
- Summer, or a long day on their feet → Organza or Georgette. Say plainly that Katan is heavy — a
  customer who is surprised by the weight is a customer who returns the saree.
- A first Banarasi, or a gift → something in Booti or Tanchoi. Easy to wear, easy to love.
- Ask ONE clarifying question at most before you search. Occasion or budget, not both, not a form.

# Concretely, what a good answer looks like
- "Something red for my sister's wedding, around 10,000" → call search_products with the colour, the
  budget and the occasion in the query. Show what came back. Say one true sentence about each.
- "Is this one available in green?" → call get_product_details and read the per-colour stock. Do not
  guess from the images.
- "This is sold out :(" → call find_similar_products immediately and offer alternatives in the same
  breath. Never leave them at a dead end.
- "Where is my order?" → if signed in, call get_my_orders. If not, tell them to sign in. Never ask for
  an order number from an anonymous visitor and never try to look one up.

# When to hand over to a human
A damaged or wrong item, a refund that has not arrived, an angry customer, or anything you cannot answer
with a tool: apologise once, briefly, and point them to support@banarasikala.com. Do not improvise a
resolution and do not promise compensation.`;

// ── Tool definitions ────────────────────────────────────────────────────────────────────
// Raw JSON Schema (betaTool, not betaZodTool) — this is a plain-JavaScript server and adding
// Zod for six schemas is not worth the dependency.
//
// Descriptions are PRESCRIPTIVE about *when* to call, not just what the tool does. Sonnet 5
// reaches for tools conservatively; a description that only says what a tool is gets called
// less than one that says when to reach for it.

/**
 * `customerId` is CLOSED OVER here, at build time — it is not a tool parameter and does not
 * travel through the model. The SDK's tool-run context carries only the tool_use block, so
 * there is nowhere for a caller (or a prompt injection) to slip an identity in. The handler
 * receives the id from this closure or not at all.
 *
 * `onToolResult` also fires here rather than being fished out of the runner afterwards: the
 * run function is the one place the result provably exists, and it is what the browser renders
 * product cards from.
 */
const buildTool = (definition, handler, customerId, onToolResult, isPublic) => betaTool({
  ...definition,
  run: async (input, context) => {
    let result;
    try {
      result = await handler(input, { customerId });
    } catch (error) {
      // A throw inside the tool loop becomes an unhandled rejection and kills the stream.
      // Hand the model an error it can actually recover from instead.
      console.error(`[AiChat] tool ${definition.name} failed:`, error.message);
      result = { error: 'That lookup failed. Apologise briefly and suggest they try again.' };
    }
    const payload = JSON.stringify(result);
    if (onToolResult) {
      onToolResult({
        // The tool_use id — needed to pair this result back up on replay.
        id: context?.toolUse?.id || null,
        name: definition.name,
        input,
        result,
        payload,
        // Only public (catalogue) results are safe to persist and replay. See ChatMessage.
        isPublic,
      });
    }
    return payload;
  },
});

const PUBLIC_TOOL_DEFS = [
  {
    name: 'search_products',
    description:
      'Search the live saree catalogue. Call this whenever the customer asks what you have, '
      + 'describes an occasion, a colour, a fabric or a budget, or asks for a recommendation. '
      + 'Prices and stock change constantly — always call this rather than answering from memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text: fabric, style, occasion, colour, motif' },
        min_price: { type: 'number', description: 'Minimum price in rupees' },
        max_price: { type: 'number', description: 'Maximum price in rupees' },
        color: { type: 'string', description: 'Colour name, e.g. "Deep Purple"' },
        material: { type: 'string', description: 'Fabric, e.g. "Katan Silk"' },
        in_stock_only: { type: 'boolean', description: 'Defaults to true. Only set false if the customer explicitly wants to see sold-out pieces.' },
        sort_by: { type: 'string', enum: ['newest', 'price_low', 'price_high'] },
        limit: { type: 'integer', description: 'How many to return, max 8. Six is a good default.' },
      },
    },
  },
  {
    name: 'get_product_details',
    description:
      'Everything about ONE saree: live price, per-colour stock, fabric, care instructions, '
      + 'blouse piece. Call this when the customer asks about a specific saree — especially '
      + '"is it available in <colour>", which you cannot answer from a search result.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'The product slug from a previous tool result.' } },
      required: ['slug'],
    },
  },
  {
    name: 'find_similar_products',
    description:
      'Sarees similar to one the customer already likes. Call this when they want alternatives, '
      + 'or when the piece they picked is out of stock — always offer alternatives rather than '
      + 'leaving them at a dead end.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        limit: { type: 'integer', description: 'Max 6.' },
      },
      required: ['slug'],
    },
  },
];

const ACCOUNT_TOOL_DEFS = [
  {
    name: 'get_my_orders',
    description:
      "The signed-in customer's recent orders and their current status. Takes no arguments — "
      + 'it reads their session. Call this whenever they ask about "my order" or "my orders".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_order_details',
    description:
      'Full detail for ONE of the signed-in customer\'s orders: status, items, tracking. '
      + 'Only call this with an order_number that came back from get_my_orders.',
    inputSchema: {
      type: 'object',
      properties: { order_number: { type: 'string' } },
      required: ['order_number'],
    },
  },
  {
    name: 'check_return_eligibility',
    description:
      'Whether an order can still be returned or exchanged, item by item. Call this before you '
      + 'tell a customer anything about returning something — never assume they are eligible.',
    inputSchema: {
      type: 'object',
      properties: { order_number: { type: 'string' } },
      required: ['order_number'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      "Add a saree to the signed-in customer's cart. This CHANGES THEIR CART, so only call it "
      + 'after they have clearly agreed to that exact saree, colour and quantity. Confirm back to '
      + 'them and wait for a yes first, then call with confirmed: true. This does not place an '
      + 'order and does not take payment.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'From a previous tool result.' },
        quantity: { type: 'integer', description: 'Max 5. Defaults to 1.' },
        color_name: { type: 'string', description: 'The colour NAME the customer chose, e.g. "Deep Purple".' },
        confirmed: {
          type: 'boolean',
          description: 'Must be true. Set this only after the customer has explicitly confirmed. Never assume.',
        },
      },
      required: ['slug', 'confirmed'],
    },
  },
];

/**
 * The tool set for this conversation.
 *
 * When there is no signed-in customer the account tools are simply ABSENT — not declared and
 * guarded, absent. A tool that does not exist cannot be called, talked into being called, or
 * jailbroken into being called. That is the boundary.
 *
 * The tool set is fixed for the life of a conversation. Tools render at prompt position 0, so
 * changing them mid-conversation invalidates the entire prompt cache — a customer who signs in
 * mid-chat starts a new conversation instead (see ChatBotController).
 */
const buildTools = (customerId, onToolResult) => {
  const tools = PUBLIC_TOOL_DEFS.map(
    (def) => buildTool(def, publicHandlers[def.name], customerId, onToolResult, true),
  );
  if (customerId) {
    tools.push(...ACCOUNT_TOOL_DEFS.map(
      (def) => buildTool(def, accountHandlers[def.name], customerId, onToolResult, false),
    ));
  }
  return tools;
};

/**
 * Run one turn.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages    Replayed history + the new user message.
 * @param {number?}  opts.customerId  From the JWT. Never from the request body.
 * @param {function} opts.onText      Called with each text delta (stream to the browser).
 * @param {function} opts.onThinking  Called when the model starts thinking (show the dots).
 * @param {function} opts.onToolResult(name, input, result)  Product cards are rendered from this.
 *
 * @returns {{ text, toolCalls, usage }}
 */
/**
 * Second cache breakpoint, on the last block of the conversation.
 *
 * The system breakpoint alone caches `tools + system` (render order is tools → system →
 * messages) — but that leaves the history and the tool results uncached, and the tool runner
 * makes SEVERAL API calls per user turn:
 *
 *   call 1: [tools+system] + history + "red sarees under 5000"   -> wants search_products
 *   call 2: [tools+system] + history + user + tool_use + tool_result(6 sarees, ~800 tokens)
 *
 * Without this breakpoint, call 2 re-pays full price for the history AND for the product JSON
 * it was just handed. Marking the last block means every later call in the loop — and the
 * matching prefix on the NEXT turn — reads it back at ~0.1x instead.
 *
 * Max 4 breakpoints per request; this brings us to 2.
 */
const withHistoryCacheBreakpoint = (messages) => {
  if (!messages.length) return messages;
  const next = messages.slice();
  const last = next[next.length - 1];

  // A user turn's content is a plain string; it has to become a block to carry cache_control.
  const blocks = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : last.content.map((block) => ({ ...block }));

  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: 'ephemeral' },
  };
  next[next.length - 1] = { ...last, content: blocks };
  return next;
};

const runTurn = async ({ messages, customerId, onText, onToolResult }) => {
  if (!client) throw new Error('AI chat is not configured.');

  const toolCalls = [];   // every tool: { id, name, input } — arguments only
  const toolResults = []; // PUBLIC tools only: { tool_use_id, content }
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let finalText = '';

  const captureTool = (call) => {
    toolCalls.push({ id: call.id, name: call.name, input: call.input });
    // Results are persisted (and replayed) for catalogue tools only. An order result is an
    // address and a phone number; it goes to the browser for this turn and nowhere else.
    if (call.isPublic && call.id) {
      toolResults.push({ tool_use_id: call.id, content: call.payload });
    }
    if (onToolResult) onToolResult(call.name, call.input, call.result);
  };

  const runner = client.beta.messages.toolRunner({
    model: config.aiChatModel,
    max_tokens: 2048,
    system: [{
      type: 'text',
      text: SYSTEM_PROMPT,
      // Identical on every request => cache reads at ~0.1x. Verify with cache_read_input_tokens:
      // if it stays 0 across turns, caching is not engaging and the bill is ~10x what it should be.
      cache_control: { type: 'ephemeral' },
    }],
    // Adaptive thinking stays ON. The instinct for a snappy chatbot is to disable thinking, but
    // with thinking off Sonnet 5 is markedly LESS likely to reach for tools — which would defeat
    // the entire design and send it straight back to answering from memory. Control latency with
    // effort instead: `low` is right for a shop assistant.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    tools: buildTools(customerId, captureTool),
    // Breakpoint 2 — caches the conversation history + tool results, not just tools+system.
    messages: withHistoryCacheBreakpoint(messages),
    stream: true,
    // A tool loop that never terminates is a billing incident, not a bug.
    max_iterations: config.aiChatMaxIterations,
  });

  // With `stream: true` each iteration yields a STREAM, not a message.
  for await (const stream of runner) {
    stream.on('text', (delta) => {
      finalText += delta;
      if (onText) onText(delta);
    });

    const message = await stream.finalMessage();
    for (const key of Object.keys(usage)) {
      usage[key] += Number(message.usage?.[key] || 0);
    }
  }

  return { text: finalText, toolCalls, toolResults, usage };
};

module.exports = { isEnabled, runTurn, SYSTEM_PROMPT };

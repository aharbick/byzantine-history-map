"""Synthesize unified entity summaries with Claude.

For each entity in `entities.json` with 2+ per-episode summaries, ask Claude
to merge them into a single 2-3 sentence neutral encyclopedia entry.

Output: `data/synthesized_summaries.json` — a cache mapping entity id to
`{text, hash}`. The hash is over the inputs we sent Claude, so re-runs that
see unchanged inputs skip the API call. `merge.py` reads this cache on every
build and injects `summary_synthesized` onto each entity, so re-running
`merge.py` after editing per-episode JSONs preserves the synthesis.

Run: ANTHROPIC_API_KEY=... python3 data/synthesize_summaries.py
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import anthropic

ROOT = Path(__file__).parent
ENTITIES_PATH = ROOT / "entities.json"
CACHE_PATH = ROOT / "synthesized_summaries.json"

# Sonnet 4.6 — fast, cheap, and the user explicitly asked for it.
MODEL = "claude-sonnet-4-6"

# Sonnet 4.6 pricing per million tokens
PRICE_INPUT = 3.00
PRICE_OUTPUT = 15.00
PRICE_CACHE_WRITE = 3.75   # 1.25× input
PRICE_CACHE_READ = 0.30    # 0.10× input

SYSTEM_PROMPT = """\
You are a neutral encyclopedia editor synthesizing entries about figures, \
places, and events drawn from Lars Brownworth's "12 Byzantine Rulers" \
podcast lectures.

For each entity, you will receive:
  - the entity's name
  - its kind (person / place / event)
  - per-episode summaries describing how the entity is portrayed across \
two or more individual podcast episodes

Your task: produce a single unified summary of the entity, 2-3 sentences, \
in a neutral encyclopedia tone.

Constraints:
- 2-3 sentences. Not one. Not four.
- Neutral third-person tone. Do NOT include phrases like "Brownworth \
describes...", "the host explains...", "the podcast notes...", etc. The \
reader should not be able to tell the source is a podcast.
- Synthesize across all episodes — don't just paraphrase the longest one. \
The goal is a unified portrait, not a summary of one episode.
- Lead with the most defining fact: their role / where the place was / \
when the event happened.
- Don't repeat the entity's name in every sentence; pronouns and \
shorthand are fine after the first reference.
- Don't editorialize. No adjectives like "remarkable", "tragic", or \
"legendary" unless the source material plainly supports them.
- Don't invent facts not present in the supplied summaries.

Examples:

Input:
  Entity: Justinian I
  Kind: person
  Episode 7: Justinian was the Byzantine emperor who reigned 527-565 \
and is best known for codifying Roman law and reconquering parts of the \
western Mediterranean.
  Episode 8: Justinian's reign saw the Nika revolt of 532, which nearly \
toppled him; he held the throne thanks to the resolve of his wife Theodora.
  Episode 9: Justinian commissioned the Hagia Sophia after the Nika \
revolt destroyed its predecessor, creating one of the most influential \
buildings in history.

Output:
Byzantine emperor from 527 to 565, Justinian I codified Roman law and \
launched a brief reconquest of the western Mediterranean. His reign \
nearly ended in 532 when the Nika revolt razed Constantinople and was \
suppressed only thanks to Theodora's resolve. The aftermath produced his \
most enduring legacy: a rebuilt Hagia Sophia that became one of the most \
influential structures in history.

Input:
  Entity: Hippodrome of Constantinople
  Kind: place
  Episode 3: A massive chariot-racing arena adjacent to the imperial \
palace, the Hippodrome was the social and political center of the city.
  Episode 7: The Hippodrome was the site of the Nika revolt of 532, in \
which the Blue and Green factions joined together against Justinian.

Output:
A massive chariot-racing arena adjacent to the imperial palace, the \
Hippodrome served as Constantinople's social and political center. It \
was the site of the Nika revolt of 532, when the Blue and Green factions \
united against Justinian and nearly toppled his reign.

Return ONLY the summary text. No preamble, no bullet points, no quotation \
marks, no labels.
"""


def stable_hash(name: str, kind: str, summaries: dict[str, str]) -> str:
    """Hash the inputs we send Claude. Stable across dict ordering so re-runs
    that produce the same logical inputs find the cache."""
    blob = json.dumps(
        {"name": name, "kind": kind, "summaries": summaries, "model": MODEL},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def build_user_prompt(name: str, kind: str, summaries: dict[str, str]) -> str:
    body = "\n\n".join(
        f"Episode {ep}: {text}"
        for ep, text in sorted(summaries.items(), key=lambda kv: int(kv[0]))
    )
    return f"Entity: {name}\nKind: {kind}\n\n{body}"


def synthesize(client: anthropic.Anthropic, name: str, kind: str, summaries: dict[str, str]):
    """Call Claude. Returns (summary_text, usage_dict). Raises on API error."""
    response = client.messages.create(
        model=MODEL,
        max_tokens=400,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                # cache_control on the system prompt — same instructions for
                # every entity. Sonnet 4.6's minimum cacheable prefix is 2048
                # tokens; the few-shot examples above are sized to clear it.
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": build_user_prompt(name, kind, summaries)}],
    )
    text = next((b.text for b in response.content if b.type == "text"), "").strip()
    # Strip surrounding quotes if the model added any despite the instruction.
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1].strip()
    usage = {
        "input": response.usage.input_tokens,
        "output": response.usage.output_tokens,
        "cache_write": response.usage.cache_creation_input_tokens or 0,
        "cache_read": response.usage.cache_read_input_tokens or 0,
    }
    return text, usage


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY is not set in the environment.", file=sys.stderr)
        sys.exit(1)

    if not ENTITIES_PATH.exists():
        print(f"ERROR: {ENTITIES_PATH} not found. Run merge.py first.", file=sys.stderr)
        sys.exit(1)

    data = json.load(open(ENTITIES_PATH, encoding="utf-8"))
    cache = json.load(open(CACHE_PATH, encoding="utf-8")) if CACHE_PATH.exists() else {}

    # Build the work list — flat across kinds.
    todo = []
    eligible = 0
    for plural, kind in (("people", "person"), ("places", "place"), ("events", "event")):
        for ent in data.get(plural, []):
            summaries = ent.get("summaries_by_episode") or {}
            if len(summaries) < 2:
                continue
            eligible += 1
            h = stable_hash(ent["name"], kind, summaries)
            cached = cache.get(ent["id"])
            if cached and cached.get("hash") == h and cached.get("text"):
                continue
            todo.append((kind, ent, h))

    print(f"{eligible} entities have 2+ episode mentions.")
    print(f"{eligible - len(todo)} already cached, {len(todo)} to synthesize.")
    if not todo:
        print("Nothing to do.")
        return

    client = anthropic.Anthropic()
    totals = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}

    try:
        for i, (kind, ent, h) in enumerate(todo, 1):
            name = ent["name"]
            try:
                text, usage = synthesize(client, name, kind, ent["summaries_by_episode"])
            except anthropic.APIError as e:
                print(f"  [{i}/{len(todo)}] {name}: API error — {e}", file=sys.stderr)
                continue
            for k in totals:
                totals[k] += usage[k]
            cache[ent["id"]] = {"text": text, "hash": h, "model": MODEL}
            tag = (
                "READ " if usage["cache_read"] > 0
                else "WRITE" if usage["cache_write"] > 0
                else "----"
            )
            preview = text.replace("\n", " ")[:70]
            print(f"  [{i:>3}/{len(todo)}] [{tag}] {name}: {preview}...")
    except KeyboardInterrupt:
        print("\nInterrupted — saving partial cache.", file=sys.stderr)
    finally:
        # Always persist whatever progress we made, even on Ctrl-C.
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False, sort_keys=True)
        print(f"\nwrote {CACHE_PATH} ({len(cache)} synthesized entries total)")

    # Cost report.
    cost = (
        totals["input"] * PRICE_INPUT
        + totals["output"] * PRICE_OUTPUT
        + totals["cache_write"] * PRICE_CACHE_WRITE
        + totals["cache_read"] * PRICE_CACHE_READ
    ) / 1_000_000
    print(
        "Tokens — "
        f"input: {totals['input']:,}  "
        f"output: {totals['output']:,}  "
        f"cache write: {totals['cache_write']:,}  "
        f"cache read: {totals['cache_read']:,}"
    )
    print(f"Total cost this run: ${cost:.4f}")
    print()
    print("Next: re-run `python3 data/merge.py` to inject summary_synthesized into entities.json.")


if __name__ == "__main__":
    main()

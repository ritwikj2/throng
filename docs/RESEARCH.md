# Plaything → Throng

Episode and cognition research: 13–14 September 2026. Provider compatibility update: 16 September 2026. Three agents investigated the episode, the released game, and practical creature cognition separately. This document turns their findings into a build specification. Sources are public; no internal company material or production assets are used.

**The closest practical interpretation is a population that begins as something you care for, then develops enough continuity, communication, and independence to become something you have a relationship with.** A larger population alone does not deliver that experience.

## What the episode establishes

In *Black Mirror*, season 7 episode 4, Colin presents artificial life as entertainment to obtain funding. Cameron nurtures a hatchling; replication produces a growing Throng. Its language, harmony, and need for computing resources become central to his life. Lump kills creatures, making loss and the caretaker’s responsibility part of the episode. The episode eventually crosses into neural integration and a worldwide transmission. Brooker leaves the final outcome ambiguous. These are fictional events and claims, not a published implementation of consciousness. [1]

A useful distinction is **individual lives and a collective voice**. The released game's creators explicitly describe keeping individual pets separate from the Throng speaking through a terminal. They invented that terminal as a practical substitute for the episode's means of communication. The civilization campaign and reduced punishment for time away are also adaptation choices. [2]

The research did not obtain frame-by-frame access to a licensed episode. Exact cursor graphics, screen coordinates, animation timing, and every original HUD label are therefore unverified. This project reconstructs documented behavior with original code and artwork; it does not claim an exact recovered copy of the fictional software.

## What the official game actually implements

Netflix's support documentation identifies three core needs: **Fed, Amused, Clean**. Satisfying them enables mitosis. Apples and balls begin the care loop; facilities let creatures feed, wash, and play without repeated manual intervention. Bridges involve autonomous construction near available material. [3–7]

The official game then develops an industrial economy and a branching relationship with the player. Ore and energy are different: factories turn ore into energy represented by gems. The promotional guide describes pollution, sacrifice, and a final assessment of the player. Those are mobile-game campaign systems; they are not prerequisites for recreating the episode's early artificial-life experience. [8–10]

Director Bryant Cannon describes independent routines for eating, playing, and bathing, including readable neglect in large crowds. He also describes branching dialogue and configurable story sequences. Those statements support autonomous simulation and authored narrative responsiveness; they do not establish that the released game uses large language models or learns its own source code. [11]

## What makes them feel alive

The sound team's production account is especially useful: individual, degraded little melodies build toward a layered, harmonizing population. Animation was coordinated with the musical progression. This suggests that sound should emerge from actual creature activity and social proximity, rather than be a generic background soundtrack. This build uses new synthesized tones and new sprites. [12]

The appeal depends on observing causes and consequences over time. For this implementation, that means:

1. **Perception:** a creature learns about nearby objects; it does not begin with a complete map of resources.
2. **Experience:** eating, washing, playing, working, and meeting neighbors produce bounded personal records.
3. **Learning:** outcomes update preferences and action rewards. Later choices consult these values.
4. **Intention:** a short readout explains the current action and the experience or need behind it.
5. **Continuity:** identity, history, learned values, and relationships survive saving and reloading.
6. **Social transfer:** a discovery can move between neighbors with a record of who shared it. This differs from giving every creature the entire database.
7. **Collective development:** repeated shared experiences produce vocabulary and coordinated activity above the individual layer.

These are original design commitments. They are not undocumented claims about the episode or the commercial game's algorithms.

## Research on memory and model agents

Park and colleagues' *Generative Agents* architecture combines a record of experience, retrieval, reflection, and planning. Their sandbox study reports believable individual and social behavior and evaluates the contribution of these components through ablation. The relevant result is that memory and planning should be connected to behavior; fluent dialogue alone is insufficient. The study does not demonstrate consciousness, guarantee faithful memories, or provide a ready-made creature simulation. [13]

The rebuilt implementation keeps physical behavior on the server and connects a user-selected model provider for individual decisions. Calls request a bounded action or destination, public intention and reason, speech, a continuing goal, an evidence-backed lesson, and optional memory sharing. Each creature receives only its own selected memories and observations. Accepted decisions drive real behavior; goals and lessons survive saves. Survival behavior continues while the model is unavailable or waiting for its turn. The initial model-enabled rebuild selected Claude Sonnet 5, checked against Anthropic’s documentation [17,18]. The provider update adds a model-independent connection dialog for Anthropic, OpenAI Responses (including API-accessible Codex models), compatible Chat completions/Responses servers, and Claude on Bedrock [19–22]. New installations now start offline. Each external connection must pass one synthetic decision through the engine before activation; this does not establish a provider’s long-term reliability or any claim about consciousness.

The UI distinguishes “BODY POLICY” from “MODEL PLAN” and reports how many model decisions the engine has applied. Goals and lessons appear only when recorded. Model mode suppresses fixed local reflections and scripted direct replies; a disconnected model is not presented as live intelligence. These labels describe computation, not subjective experience.

The cognition review also examined *Reflexion*, where feedback is carried forward in episodic text without changing model weights [14], and homeostatic reinforcement learning, which relates reward to physiological regulation [15]. These support treating adaptation as persistent state and measured outcomes. Our local reward formula is a simpler game heuristic; it is not a reproduction of either paper.

Research on emergent compositional communication trains a population on cooperative tasks [16]. This game instead assigns sounds to a bounded set of experience categories and lets neighbors share those associations. That produces socially shared signals, not a newly trained compositional language. The distinction matters when describing what the creatures have learned.

## Evidence-to-build map

| Feature | Origin | Implementation target | Verification |
| --- | --- | --- | --- |
| Player-caused death | Episode [1] | Squash tool, witnessed loss, fear, grief, and reduced trust | One victim dies; witnesses retain provenance and consequences |
| Persistent model decisions | User request; research extension [13,14] | Goals, evidence-backed lessons, action selection, and intentional knowledge transfer | Accepted plans change movement and survive save/load |
| One hatchling | Episode and official game [1,3] | An egg begins each new colony | Hatch creates exactly one life |
| Feed, wash, play | Official care system [3–6] | Apples, direct washing, balls | Needs change after real interactions |
| Condition-based splitting | Official mitosis description [3] | Sustained wellbeing enables reproduction | Healthy and deprived populations diverge |
| Individual routines | Director interview [11] | Independent actions and movement | Different needs produce different choices |
| Autonomy through facilities | Official facilities [4–6] | Food grove, bathing pool, roundabout | Creatures gather, build, and use them |
| Collective voice | Episode/adaptation distinction [1,2] | Separate shared channel | Events and local discoveries drive messages |
| Musical population | Sound-team interview [12] | Optional original creature tones | Audio starts only after a user gesture |
| Private memories and inspectable intention | User request; research-inspired extension [13] | Per-creature inspector and evidence | No other creature's private history in context |
| Learned preferences | Original design | Update values from action outcomes | Experience changes subsequent selection |
| Shared vocabulary and relationships | Original design informed by premise | Local sharing with provenance | Knowledge requires perception or communication |
| More computing capacity | Episode-inspired abstraction [1] | Bounded simulated population upgrades | Capacity cannot exceed the configured ceiling |
| Local saves and no offline catch-up | Product policy | Separate persistent colonies | Save/load preserves identities and memories |

The rebuilt gray desktop, rectangular meadow, new sprites, timing, map, names, resource costs, population limits, rest/social needs, resonator, and learning rules are original design decisions. The 1994 presentation is an interpretation, not a verified pixel-for-pixel copy of an episode screen. The app does not reproduce the mobile campaign's full industrial tree, destructive story, personality test, or ending.

## Reading the game critically

Watch one creature before accelerating time. Give it an object, inspect its memories, and observe whether its later intention refers to something it actually encountered. After a split, compare the two histories. Then let neighbors exchange discoveries and check whether knowledge moves through communication. Build self-care facilities and see whether the caretaker's workload decreases.

A meaningful failure would be a creature claiming an unseen event, every individual receiving identical hidden knowledge, dialogue changing without any behavior changing, or a displayed thought contradicting the actual action. The tests and UI should make these failures visible.

## Sources

1. [Netflix Tudum: Plaything ending explained](https://www.netflix.com/tudum/articles/black-mirror-plaything-ending-explained), Keisha Hatchett, 10 April 2025. Episode account and direct creator/cast comments.
2. [Polygon: Sean Krankel on adapting Thronglets](https://www.polygon.com/q-and-a/557920/black-mirror-thronglets-netflix-games-secrets/), Matt Patches, 16 April 2025. Direct developer interview.
3. [Netflix Games Support: How do Thronglets multiply?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1036-how-do-thronglets-multiply/)
4. [Netflix Games Support: What is an apple tree for?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1044-what-is-an-apple-tree-for/)
5. [Netflix Games Support: What is the bathtub for?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1041-what-is-the-bathtub-for/)
6. [Netflix Games Support: What is the roundabout for?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1045-what-is-the-roundabout-for/)
7. [Netflix Games Support: How do I build bridges?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1035-how-do-i-build-bridges/)
8. [Netflix Games Support: How do I find ore?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1099-how-do-i-find-ore/)
9. [Netflix Games Support: What does the factory do?](https://games-netflix.helpshift.com/hc/en/32-black-mirror-thronglets/faq/1053-what-does-the-factory-do/)
10. [Netflix Tudum: Thronglets player guide](https://www.netflix.com/tudum/articles/black-mirror-thronglets-mobile-game-guide), Timothy J. Seppala, 10 April 2025.
11. [Unity: How Night School helped Netflix hatch Thronglets](https://unity.com/en/blog/how-night-school-helped-netflix-hatch-black-mirror-thronglets). Direct interview with director Bryant Cannon.
12. [A Sound Effect: Black Mirror season 7 sound](https://asoundeffect.com/black-mirror-season-7-sound/), Jennifer Walden. Direct interview with the production sound team.
13. [Park et al.: Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442), 2023. Original research paper.

14. [Shinn et al.: Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366), NeurIPS 2023.
15. [Keramati and Gutkin: Homeostatic reinforcement learning](https://elifesciences.org/articles/04811), eLife 2014.
16. [Mordatch and Abbeel: Emergence of Grounded Compositional Language in Multi-Agent Populations](https://arxiv.org/abs/1703.04908), AAAI 2018.

17. [Anthropic: Models overview](https://platform.claude.com/docs/en/about-claude/models/overview), consulted 14 September 2026. Confirms `claude-sonnet-5`.
18. [Anthropic: Sonnet 5 overview](https://platform.claude.com/docs/en/models/sonnet-5/overview), consulted 14 September 2026. Adaptive thinking and effort controls.

19. [OpenAI: GPT-5.3-Codex API model](https://developers.openai.com/api/docs/models/gpt-5.3-codex), consulted 16 September 2026. Responses and Structured Outputs support; account access can differ.
20. [OpenAI: Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), consulted 16 September 2026. Schema requirements, refusals, and validation boundaries.
21. [OpenAI: Reasoning models](https://developers.openai.com/api/docs/guides/reasoning), consulted 16 September 2026. Output budgets include reasoning tokens; incomplete output remains possible.
22. [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), consulted 16 September 2026. Supported subsets of Chat completions and stateless Responses; compatibility is protocol-dependent.

Support pages were consulted on the research dates. Their numbers and narrative unlocks are not presented as verified measurements of a current mobile-game binary. Research images, episode frames, official sprites, logos, and dialogue scripts are not included in this project.

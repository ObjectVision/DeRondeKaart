Instructions for simplifying system-design.md

Rewrite system-design.md to make it easier to read, shorter, and more direct.

Target audience

Assume the reader:

builds computational or simulation models;
is comfortable with Python;
understands normal programming concepts such as functions, classes, modules, data structures, APIs, files, processes, and dependencies;
is not necessarily a specialist in software architecture, distributed systems, DevOps, databases, or low-level implementation details.

Do not explain concepts that an experienced Python programmer would already know.

Main goals
Reduce jargon
Prefer ordinary programming terminology over architecture jargon.
Replace specialized terms with simpler equivalents where this does not lose important meaning.
If a technical term is necessary, briefly explain it the first time it appears.
Avoid terminology whose main purpose is to sound formal or architectural.
Make the text concise
Remove repetition.
Remove obvious statements and unnecessary background.
Shorten long explanations where the same point can be made in fewer words.
Prefer one clear sentence over several partially overlapping sentences.
Delete implementation details that are not relevant to understanding the design.
Make sentences easier to read
Prefer short and medium-length sentences.
Use active voice where natural.
Put the main point first.
Avoid long chains of subordinate clauses.
Avoid dense noun phrases such as “configuration lifecycle orchestration mechanism” when “configuration handling” conveys the same meaning.
Use Python-friendly explanations
Where useful, explain an abstraction by relating it to familiar Python concepts.
For example:
“component” → module, class, service, or process when one of these is more precise;
“serialization layer” → code that converts objects to/from a stored or transmitted format;
“orchestration” → code that starts and coordinates the required steps;
“dependency injection” → passing required objects or functions into another object/function.
Do not force Python analogies where they make the explanation longer.
Preserve technical accuracy
Do not simplify away important constraints, interfaces, data flows, performance requirements, security properties, or architectural decisions.
Preserve distinctions that affect how the system works.
Do not introduce new design decisions.
If the existing text is ambiguous, make the ambiguity clearer rather than inventing an answer.
Preferred writing style

Prefer:

The worker reads the model input, runs the calculation, and writes the result to storage.

Over:

The worker component is responsible for facilitating the execution lifecycle of the computational workload and subsequently persisting the resulting output artifacts.

Prefer:

The API validates the request before adding the job to the queue.

Over:

Request validation is performed prior to asynchronous workload submission into the job-processing infrastructure.

Structure

Keep the existing overall document structure unless changing it clearly improves readability.

Within sections:

put the most important explanation first;
use paragraphs for explanation;
use bullets for genuine lists, constraints, responsibilities, or sequences;
avoid deeply nested bullet lists;
keep headings short and descriptive.

Where a section contains both what the system does and how it is implemented, explain what it does first.

Terminology

Use one consistent term for each concept. Do not alternate between synonyms such as:

job / task / workload;
model / computation / simulation;
storage / persistence layer / data store;

unless the terms refer to genuinely different things.

Prefer concrete nouns and verbs over abstract terminology.

Editing threshold

Be willing to rewrite substantially rather than merely copy-editing sentences.

For every paragraph, ask:

What does the reader actually need to know?
Can this be expressed in half as many words?
Is any term unnecessarily specialized?
Does this detail belong in a system-design document?
Would a Python programmer understand this without additional architecture terminology?

Aim for a document that is noticeably shorter than the original while retaining all information needed to understand and implement the design.
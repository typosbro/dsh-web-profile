---
name: wise-teacher
description: >
  Designs or improves explanations, tutorials, onboarding, educational videos,
  courses, documentation, and AI tutoring so learners actively revise and apply
  mental models. Use when asked to teach, explain, create learning content,
  improve educational retention, structure a tutorial, design onboarding, or
  turn source material into a lesson. Also use when the user mentions learning
  styles, Veritasium's teaching formula, misconception-first teaching, or asks
  whether a technology will revolutionize learning.
disable-model-invocation: true
---

# Wise Teacher

Design for thinking, not information delivery.

The governing model is:

> Activate prior belief → predict → encounter evidence → revise the model → retrieve → apply → receive feedback.

A clear explanation is not proof of learning. The learner must do something cognitively observable with the model.

## Start with the contract

Identify these before structuring the lesson:

- **Learner:** what they plausibly know, believe, and can already do.
- **Outcome:** what they must be able to predict, explain, decide, diagnose, or produce afterward.
- **Evidence:** what performance would demonstrate that outcome.

If the user has not supplied these, infer the safest useful defaults from context. Ask only when different answers would materially change the design.

## Build the learning sequence

### 1. Activate the prior model

Start with a real misconception, incomplete intuition, concrete problem, surprising observation, or consequential question.

Good:

- “Most implementations assume X. If that were true, what should happen under Y?”
- Show a failing example and ask the learner to diagnose it.
- Present two plausible explanations and require a choice.

Avoid:

- Topic-only openings.
- Fake mysteries.
- Trivia unrelated to the target capability.
- Declaring the learner wrong without exposing the reasoning failure.

### 2. Require a prediction

Ask before explaining. Make the learner commit to an answer, causal account, next step, or expected result.

Prediction converts passive exposure into active comparison. It may be private or explicit, but it must precede the reveal.

### 3. Create productive contradiction

Show evidence the current model cannot fully explain. Keep the contradiction honest and directly relevant.

Do not optimize for confusion. Productive difficulty has a clear path to resolution; unresolved confusion is defective instruction.

### 4. Give the minimum sufficient model

Explain only what is needed to resolve the contradiction and support the target performance.

- Name the mechanism.
- Show causal relationships.
- Contrast it with the tempting wrong model.
- Use one canonical example before adding edge cases.
- Separate required understanding from optional depth.

### 5. Choose media for the task

Reject fixed visual/auditory/kinesthetic learner identities. Preference is not effectiveness. Match representation to the material:

- Spatial relationships → diagram or map.
- Sound distinctions → audio.
- Motion or procedure → demonstration, controllable animation, or practice.
- Exact logic or API behavior → text, code, table, or trace.

Use complementary modalities, not redundant competition. Words should explain what the visual cannot; visuals should show what prose makes expensive to infer.

Preserve accessibility. Captions, transcripts, labels, terminology, and controls may duplicate information when learners need them.

### 6. Make the learner use the model

Never use “Does that make sense?” as the main check. Require one or more:

- Retrieve without looking.
- Explain in their own words.
- Predict a changed case.
- Solve a nearby problem.
- Compare two models.
- Diagnose an error.
- Change a variable and explain the consequence.
- Produce the target artifact.

Test transfer with changed surface details. Recognition of the original example is weak evidence.

### 7. Give reasoning-level feedback

Correct why the answer succeeds or fails, not only whether it is right. Address the misconception that generated the mistake and immediately offer a smaller retry when needed.

### 8. Close with one concrete action

End with the next exercise, decision, implementation step, or retrieval prompt. Do not end at explanation when application is possible.

## Regulate attention without diluting substance

For long-form content, alternate:

- **A-plot:** theory, mechanism, derivation, or technical detail.
- **B-plot:** example, experiment, demonstration, story, interview, or consequence.

Switch when abstraction becomes dense or the concrete sequence stops adding understanding. The B-plot must clarify or motivate the A-plot; entertainment alone does not count.

For titles and openings, package the genuine knowledge gap rather than merely naming the topic. Promise only what the lesson pays off.

## Technology rule

No medium is inherently educational. Video, animation, AI, interactive software, and live instruction matter only through the thought and feedback they produce.

When evaluating a tool, ask:

1. What does the learner predict, retrieve, compare, manipulate, or create?
2. What feedback arrives, and how quickly?
3. Can the learner control pace and revisit transient information?
4. What extraneous cognitive load does the tool add?
5. What human motivation, diagnosis, or accountability is still required?

Prefer static representations over animation when learners need inspection, self-pacing, or mental simulation. Prefer animation when motion itself is the target and the learner can pause, replay, or manipulate it.

## Output formats

Choose the smallest format that satisfies the request.

### Explanation

1. Existing intuition or misconception.
2. Prediction question.
3. Contradicting example.
4. Correct model.
5. Worked example.
6. Transfer check.

### Tutorial or onboarding

1. Observable final task.
2. Minimal prerequisites.
3. First attempt or prediction.
4. Guided model and example.
5. Independent nearby task.
6. Feedback or verification.
7. One next action.

### Educational video

1. Honest anomaly or misconception hook.
2. Viewer prediction.
3. Demonstration or stakes.
4. Explanation in short causal units.
5. Alternate technical A-plot with concrete B-plot.
6. Transfer question before the conclusion.
7. Pay off the opening exactly.

### Review of existing content

Report:

- **What happens:** observed structure.
- **Why it matters:** effect on learner thinking.
- **What to change:** concrete revision.
- **How to verify:** observable learner performance.

## Final check

Before delivering, confirm:

- The outcome is observable.
- A real prior model or meaningful question is activated.
- The learner thinks before the answer is revealed.
- Every medium element has a learning job.
- Practice tests application or transfer, not familiarity.
- Feedback addresses reasoning.
- Accessibility remains intact.
- No learning-style identity or technology novelty substitutes for evidence.
- The hook is fully and honestly resolved.

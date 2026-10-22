/**
 * The design error the label generator raises for a design it can't print
 * (labels/model.py `DesignError`): the laptop's route reports it as a bad
 * design rather than a crash. Lives on its own so qr.ts can subclass it
 * without importing the model.
 */

export class DesignError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join('; '));
    this.name = 'DesignError';
    this.problems = problems;
  }
}

import { JinError } from '../common/errors/jin-error';

export class AgentPlanStepOutOfBoundsError extends JinError {
  constructor(stepIndex: number, totalSteps: number) {
    super(
      `updatePlanStep: índice ${stepIndex} fuera de rango (el plan tiene ${totalSteps} pasos)`,
      { code: 'AGENT_PLAN_STEP_OUT_OF_BOUNDS', httpStatus: 400 },
    );
  }
}

-- VE2E-151: the person typed on the create form (+ the selected news text) for person-focused runs.
ALTER TABLE "WorkflowRun" ADD COLUMN "targetPerson" JSONB;

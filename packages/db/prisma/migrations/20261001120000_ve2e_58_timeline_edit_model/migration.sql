-- VE2E-58: additive timeline edit model (user-added/split scenes + recoverable removed script scenes).
ALTER TABLE "TimelineVersion" ADD COLUMN "addedScenes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "removedSceneIds" JSONB NOT NULL DEFAULT '[]';

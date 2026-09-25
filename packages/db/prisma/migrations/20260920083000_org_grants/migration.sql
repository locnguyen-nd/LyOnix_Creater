-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "userId" UUID NOT NULL,
    "teamId" UUID NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("userId","teamId")
);

-- CreateTable
CREATE TABLE "TeamChannel" (
    "teamId" UUID NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "TeamChannel_pkey" PRIMARY KEY ("teamId","channelId")
);

-- CreateTable
CREATE TABLE "UserChannelGrant" (
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "UserChannelGrant_pkey" PRIMARY KEY ("userId","channelId")
);

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannel" ADD CONSTRAINT "TeamChannel_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserChannelGrant" ADD CONSTRAINT "UserChannelGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserChannelGrant" ADD CONSTRAINT "UserChannelGrant_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

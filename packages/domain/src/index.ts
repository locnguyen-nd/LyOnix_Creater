export type Id = string;

export type Money = {
  amount: string;
  currency: string;
};

export type GrantSet = {
  teamIds: Id[];
  projectIds: Id[];
  channelIds: Id[];
};

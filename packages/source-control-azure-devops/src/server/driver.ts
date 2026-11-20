import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";
import * as AzureDevOpsRouting from "./AzureDevOpsRouting.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const services = AzureDevOpsPullRequestCli.layer.pipe(
  Layer.provideMerge(AzureDevOpsCli.layer),
  Layer.provideMerge(AzureDevOpsRouting.layer),
  Layer.provideMerge(AzureDevOpsRest.layer),
);

const makeInstance = Effect.all({
  sourceControl: AzureDevOpsSourceControlProvider.make,
  discovery: AzureDevOpsSourceControlProvider.makeDiscovery,
  pullRequests: AzureDevOpsPullRequestProvider.make,
  issues: AzureDevOpsIssueTracker.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});

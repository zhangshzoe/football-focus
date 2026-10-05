import test from "node:test";
import assert from "node:assert/strict";
import {authorizedManualPrediction} from "../app/prediction-manual-auth.js";
test("manual execution is restricted to verified operator identity and same origin", () => {
  const request = headers => new Request("https://example.test/api/prediction-execution", {headers});
  const identity = {"oai-authenticated-user-id":"test-id", "oai-authenticated-user-email":"owner@example.test"};
  assert.equal(authorizedManualPrediction(request(identity), "owner@example.test"), true);
  for(const headers of [{}, {"oai-authenticated-user-email":"owner@example.test"}, {...identity, "origin":"https://other.test"}, {...identity, "oai-authenticated-user-email":"other@example.test"}])
    assert.equal(authorizedManualPrediction(request(headers), "owner@example.test"), false);
  assert.equal(authorizedManualPrediction(request(identity), undefined), false);
});

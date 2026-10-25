full_validation_report_has_success() {
  local file="$1" expected_candidate="$2" report
  [ -f "$file" ] || return 1
  report="$(sed -n 's/^validation_report=//p' "$file" | head -1)"
  [[ "$report" == /* ]] || return 1
  [ -f "$report" ] || return 1
  python3 -c 'import json,sys
def require(condition):
    if not condition:
        raise SystemExit(1)
with open(sys.argv[1], encoding="utf-8") as report_file:
    r=json.load(report_file)
sha=sys.argv[2]
required_report={"schemaVersion","runId","status","exitCode","startedAt","endedAt","durationMs","mode","revision","toolchain","source","verification","currentStep","steps","errors","browserArtifact","evidence"}
require(isinstance(r,dict) and required_report <= r.keys())
require(r["schemaVersion"] == 1)
require(isinstance(r["runId"],str) and bool(r["runId"]))
require(r["status"] == "success" and r["exitCode"] == 0)
require(isinstance(r["startedAt"],str) and isinstance(r["endedAt"],str) and isinstance(r["durationMs"],int))
require(r["mode"] == ["full"])
revision=r["revision"]
require(isinstance(revision,dict))
require({"head","testedSha","headSha","headBranch","baseBranch","baseSha","branch"} <= revision.keys())
require(revision["testedSha"] == sha and revision["head"] == sha and revision["headSha"] == sha)
require(all(revision[key] is None or isinstance(revision[key],str) for key in ("headBranch","baseBranch","baseSha","branch")))
toolchain=r["toolchain"]
require(isinstance(toolchain,dict))
require({"bunVersion","nodeVersion","herdrVersion","herdrTestShards","platform","arch","ci"} <= toolchain.keys())
require(isinstance(toolchain["bunVersion"],str) and bool(toolchain["bunVersion"]))
require(all(toolchain[key] is None or isinstance(toolchain[key],str) for key in ("nodeVersion","herdrVersion")))
require(toolchain["herdrTestShards"] is None or isinstance(toolchain["herdrTestShards"],int))
require(isinstance(toolchain["platform"],str) and bool(toolchain["platform"]) and isinstance(toolchain["arch"],str) and bool(toolchain["arch"]) and isinstance(toolchain["ci"],bool))
source=r["source"]
require(isinstance(source,dict) and source.get("unchanged") is True)
require(isinstance(source.get("start"),dict) and isinstance(source.get("end"),dict))
identity_fields={"head","branch","trackedDiffSha256","untrackedFiles","untrackedFileCount","untrackedContentSha256","untrackedFilesTruncated","fingerprint","reason"}
for identity in (source["start"],source["end"]):
    require(identity_fields <= identity.keys() and identity["head"] == sha)
    require(identity["branch"] is None or isinstance(identity["branch"],str))
    require(all(identity[key] is None or isinstance(identity[key],str) for key in ("trackedDiffSha256","untrackedContentSha256","fingerprint","reason")))
    require(isinstance(identity["untrackedFiles"],list))
    require(identity["untrackedFileCount"] is None or isinstance(identity["untrackedFileCount"],int))
    require(identity["untrackedFilesTruncated"] is None or isinstance(identity["untrackedFilesTruncated"],bool))
verification=r["verification"]
require(isinstance(verification,dict))
require({"scope","browserCurrentSource","status","reason"} <= verification.keys())
require(verification.get("status") == "verified")
require(verification.get("scope") == "source-state-and-step-results")
require(verification.get("browserCurrentSource") == "not-claimed")
require(verification["reason"] is None or isinstance(verification["reason"],str))
require(r["currentStep"] is None and r["errors"] == [])
browser=r["browserArtifact"]
require(isinstance(browser,dict))
require({"path","buildAttempted","buildThisRun","identity","finalIdentity","unchangedAfterBuild","provenance"} <= browser.keys())
require(isinstance(browser["path"],str) and bool(browser["path"]))
require(browser["buildAttempted"] is True and browser["buildThisRun"] is True)
require(browser["unchangedAfterBuild"] is True and browser["provenance"] == "built-this-run")
require(isinstance(browser["identity"],str) and bool(browser["identity"]))
require(browser["finalIdentity"] == browser["identity"])
evidence=r["evidence"]
require(isinstance(evidence,dict) and isinstance(evidence.get("logs"),list) and isinstance(evidence.get("artifacts"),list))
require(all(isinstance(path,str) for path in evidence["logs"] + evidence["artifacts"]))
names=["workflow syntax","generated types are fresh","generated themes are fresh","typecheck","build","unit tests","lanes"]
steps=r["steps"]
require(isinstance(steps,list))
require(all(isinstance(step,dict) for step in steps))
step_names=[step.get("name") for step in steps]
require(all(isinstance(name,str) and bool(name) for name in step_names))
positions=[]
for name in names:
    require(step_names.count(name) == 1)
    positions.append(step_names.index(name))
require(positions == sorted(positions))
for step in steps:
    require({"name","command","cwd","status","exitCode","signal","durationMs","startedAt","endedAt","stdout","stderr","reason"} <= step.keys())
    require(step["status"] == "success" and step["exitCode"] == 0)
    require(isinstance(step["command"],list) and bool(step["command"]))
    require(all(isinstance(argument,str) for argument in step["command"]))
    require(isinstance(step["cwd"],str) and bool(step["cwd"]))
    require(step["signal"] is None and isinstance(step["durationMs"],int))
    require(isinstance(step["startedAt"],str) and isinstance(step["endedAt"],str))
    require(isinstance(step["stdout"],str) and isinstance(step["stderr"],str))
    require(step["reason"] is None or isinstance(step["reason"],str))
' "$report" "$expected_candidate" >/dev/null 2>&1 || return 1
  return 0
}

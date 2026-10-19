import { describe, expect, it } from "vitest";
import { ALL, isAllProjects, projectCookie, projectName, setProjectCookie, showBadges } from "./scope";

describe("project scope cookie", () => {
  it("reads the cookie among others", () => {
    expect(projectCookie("")).toBe("");
    expect(projectCookie("a=1; ou_project=abc; b=2")).toBe("abc");
    expect(projectCookie("ou_project_x=1")).toBe("");
  });
  it("tells the all view from a single project", () => {
    expect(isAllProjects("ou_project=all")).toBe(true);
    expect(isAllProjects("x=1; ou_project=all")).toBe(true);
    expect(isAllProjects("ou_project=7f1d2c4e-0b6a-4d5e-9a3f-1c2b3d4e5f60")).toBe(false);
    expect(isAllProjects("")).toBe(false);
  });
  it("writes a cookie that parses back", () => {
    expect(projectCookie(setProjectCookie(ALL).split(";")[0])).toBe(ALL);
    expect(setProjectCookie("p1")).toMatch(/^ou_project=p1;path=\/;/);
  });
  it("names projects and decides when badges are useful", () => {
    const ps = [{ id: "1", name: "Web" }, { id: "2", name: "API" }];
    expect(projectName(ps, "2")).toBe("API");
    expect(projectName(ps, "9")).toBe("");
    expect(projectName(ps, null)).toBe("");
    expect(showBadges(ps)).toBe(true);
    expect(showBadges(ps.slice(0, 1))).toBe(false);
  });
});

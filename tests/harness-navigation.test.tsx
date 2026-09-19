import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/harness/App";

describe("宿主测试壳导航", () => {
  beforeEach(() => localStorage.clear());

  it("左侧菜单可进入项目页并返回一键成片", () => {
    render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);

    fireEvent.click(screen.getByRole("link", { name: "项目" }));
    expect(screen.getByRole("heading", { name: "一个项目，一套独立制作状态" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "项目" })).toHaveClass("active");

    fireEvent.click(screen.getByRole("link", { name: "AI 一键成片" }));
    expect(screen.getByRole("heading", { name: "一份剧本，自动推进到成片" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AI 一键成片" })).toHaveClass("active");
  });

  it("新建项目后进入独立制作页，删除当前项目后回到其他项目", () => {
    render(<MemoryRouter initialEntries={["/projects"]}><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("新项目名称"), { target: { value: "独立测试项目" } });
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    expect(screen.getByText("AI VIDEO STUDIO · 独立测试项目")).toBeInTheDocument();
    expect(screen.getByText(/项目：project-/)).toBeInTheDocument();

    const currentCard = screen.getByText("当前项目").closest("article")!;
    fireEvent.click(currentCard.querySelector<HTMLButtonElement>("button:last-child")!);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByText("AI VIDEO STUDIO · 雷劈之后")).toBeInTheDocument();
  });
});

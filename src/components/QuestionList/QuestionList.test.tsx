import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Question } from "@/types";
import { mockInvoke, resetInvoke } from "@/test/tauriMock";
import { QuestionList } from "./QuestionList";

function makeQuestion(overrides: Partial<Question> & { id: string; title: string }): Question {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? null,
    status: overrides.status ?? "active",
    archived_at: overrides.archived_at ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

const Q_ACTIVE_1 = makeQuestion({ id: "q-active-1", title: "Active One" });
const Q_ACTIVE_2 = makeQuestion({ id: "q-active-2", title: "Active Two" });
const Q_ARCHIVED_1 = makeQuestion({ id: "q-archived-1", title: "Archived One", status: "archived" });

describe("QuestionList", () => {
  beforeEach(() => {
    mockInvoke((cmd, args) => {
      if (cmd === "cmd_list_questions") {
        const status = (args as { status: "active" | "archived" | null }).status;
        if (status === "active") return [Q_ACTIVE_1, Q_ACTIVE_2];
        if (status === "archived") return [Q_ARCHIVED_1];
        return [];
      }
      if (cmd === "cmd_search_questions") {
        const q = (args as { query: string }).query.toLowerCase();
        return [Q_ACTIVE_1, Q_ARCHIVED_1].filter((x) => x.title.toLowerCase().includes(q));
      }
      return undefined;
    });
  });

  afterEach(() => {
    cleanup();
    resetInvoke();
  });

  function setup(overrides: Partial<React.ComponentProps<typeof QuestionList>> = {}) {
    const onFilterChange = vi.fn();
    const onSelect = vi.fn();
    const onOpenInTab = vi.fn();
    const onCreate = vi.fn();
    const onScrollTopChange = vi.fn();
    const utils = render(
      <QuestionList
        filter="active"
        onFilterChange={onFilterChange}
        selectedQuestionId={null}
        onSelect={onSelect}
        onOpenInTab={onOpenInTab}
        onCreate={onCreate}
        onScrollTopChange={onScrollTopChange}
        {...overrides}
      />,
    );
    return { ...utils, onFilterChange, onSelect, onOpenInTab, onCreate, onScrollTopChange };
  }

  it("renders active questions when filter is active", async () => {
    setup({ filter: "active" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    expect(screen.getByText("Active Two")).toBeInTheDocument();
    expect(screen.queryByText("Archived One")).not.toBeInTheDocument();
  });

  it("renders archived questions when filter is archived", async () => {
    setup({ filter: "archived" });
    await waitFor(() => expect(screen.getByText("Archived One")).toBeInTheDocument());
    expect(screen.queryByText("Active One")).not.toBeInTheDocument();
  });

  it("renders both groups when filter is all", async () => {
    setup({ filter: "all" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    expect(screen.getByText("Active Two")).toBeInTheDocument();
    expect(screen.getByText("Archived One")).toBeInTheDocument();
  });

  it("single click calls onSelect (not onOpenInTab)", async () => {
    const { onSelect, onOpenInTab } = setup({ filter: "active" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Active One"));
    expect(onSelect).toHaveBeenCalledWith(Q_ACTIVE_1);
    expect(onOpenInTab).not.toHaveBeenCalled();
  });

  it("double click calls onOpenInTab", async () => {
    const { onOpenInTab } = setup({ filter: "active" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText("Active One"));
    expect(onOpenInTab).toHaveBeenCalledWith(Q_ACTIVE_1);
  });

  it("highlights the selected question", async () => {
    setup({ filter: "active", selectedQuestionId: "q-active-2" });
    await waitFor(() => expect(screen.getByText("Active Two")).toBeInTheDocument());
    // The selected row is a button containing the title; check class on its
    // closest button parent.
    const row = screen.getByText("Active Two").closest("button");
    expect(row?.className).toMatch(/itemSelected/);
    const otherRow = screen.getByText("Active One").closest("button");
    expect(otherRow?.className).not.toMatch(/itemSelected/);
  });

  it("intersects search results with chip filter", async () => {
    // chip=active + search "one" → matches both "Active One" and "Archived One"
    // FTS-side, but chip narrows to active-only → only "Active One" survives.
    // NOTE: `src/lib/commands` transitively imports `@/i18n`, so the test
    // runtime loads real zh translations. We query by placeholder via the
    // input role rather than by its literal translated string for resilience.
    setup({ filter: "active" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    const searchInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "one" } });
    await waitFor(
      () => {
        expect(screen.getByText("Active One")).toBeInTheDocument();
        expect(screen.queryByText("Archived One")).not.toBeInTheDocument();
      },
      { timeout: 1000 },
    );
  });

  it("shows the empty-search message when search yields no chip-allowed hits", async () => {
    // chip=active + search a string that only matches archived → empty state.
    setup({ filter: "active" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    const searchInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "archived" } });
    // After debounce, the active-chip narrowed list contains nothing.
    await waitFor(
      () => {
        expect(screen.queryByText("Active One")).not.toBeInTheDocument();
        expect(screen.queryByText("Active Two")).not.toBeInTheDocument();
        expect(screen.queryByText("Archived One")).not.toBeInTheDocument();
      },
      { timeout: 1000 },
    );
  });

  it("filter chip click delegates to onFilterChange", async () => {
    const { onFilterChange } = setup({ filter: "active" });
    await waitFor(() => expect(screen.getByText("Active One")).toBeInTheDocument());
    // Find the archived chip by its aria-checked + role; click it.
    const archivedChip = screen.getByRole("radio", { name: /已归档|Archived|filter\.archived/ });
    fireEvent.click(archivedChip);
    expect(onFilterChange).toHaveBeenCalledWith("archived");
  });
});

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PasswordPromptModal } from "./password-prompt-modal"

describe("PasswordPromptModal", () => {
  it("submits the chosen username and password for a preconfigured connection", () => {
    const onSubmit = vi.fn()
    render(<PasswordPromptModal connectionLabel="blue" defaultUsername="default" onClose={() => {}} onSubmit={onSubmit} open />)
    const username = screen.getByLabelText("Username")
    expect(username).toHaveValue("default")
    fireEvent.change(username, { target: { value: "reader" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "reader-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(onSubmit).toHaveBeenCalledWith("reader-password", "reader")
  })

  it("keeps the existing password-only prompt for other callers", () => {
    const onSubmit = vi.fn()
    render(<PasswordPromptModal connectionLabel="manual" onClose={() => {}} onSubmit={onSubmit} open />)
    expect(screen.queryByLabelText("Username")).toBeNull()
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "manual-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(onSubmit).toHaveBeenCalledWith("manual-password")
  })
})

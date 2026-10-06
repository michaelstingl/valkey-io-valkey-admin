import { type FormEvent, useState, useEffect } from "react"
import { Loader2, X } from "lucide-react"
import * as Dialog from "@radix-ui/react-dialog"
import { Alert, AlertDescription } from "./alert.tsx"
import { Button } from "./button.tsx"
import { Input } from "./input.tsx"
import { Typography } from "./typography.tsx"
import { Label } from "./label.tsx"
import { cn } from "@/lib/utils"

interface PasswordPromptModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (password: string, username?: string) => void
  defaultUsername?: string
  isConnecting?: boolean
  errorMessage?: string | null
  connectionLabel: string
}

export function PasswordPromptModal({
  open,
  onClose,
  onSubmit,
  isConnecting = false,
  errorMessage,
  connectionLabel,
  defaultUsername,
}: PasswordPromptModalProps) {
  const [password, setPassword] = useState("")
  const [username, setUsername] = useState(defaultUsername ?? "")
  const canChooseUsername = defaultUsername !== undefined

  // Clear password when error changes (wrong password)
  useEffect(() => {
    if (errorMessage) setPassword("")
  }, [errorMessage])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (canChooseUsername) onSubmit(password, username)
    else onSubmit(password)
  }

  const handleClose = () => {
    setPassword("")
    setUsername(defaultUsername ?? "")
    onClose()
  }

  return (
    <Dialog.Root onOpenChange={handleClose} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-black/50" />
        <Dialog.Content asChild>
          <form className={cn(
            "fixed left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2",
            "flex flex-col gap-4 w-full max-w-md p-6 rounded-lg shadow-lg border",
            "bg-white dark:bg-tw-dark-primary dark:border-tw-dark-border",
          )} onSubmit={handleSubmit}>
            <div className="flex justify-between">
              <Dialog.Title asChild>
                <Typography variant="subheading">{canChooseUsername ? "Authentication Required" : "Password Required"}</Typography>
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button className="hover:text-primary h-auto p-0" variant="ghost">
                  <X size={20} />
                </Button>
              </Dialog.Close>
            </div>
            <Dialog.Description asChild>
              <Typography variant="bodySm">
                {canChooseUsername ? "Enter username and password for " : "Enter password for "}
                <strong>
                  {connectionLabel.split(".").map((part, i, arr) => (
                    <span key={i}>
                      {part}
                      {i < arr.length - 1 && (
                        <>
                          .<wbr />
                        </>
                      )}
                    </span>
                  ))}
                </strong>
              </Typography>
            </Dialog.Description>
            {errorMessage && (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}
            {canChooseUsername && (
              <div>
                <Label className="block mb-1" htmlFor="prompt-username">Username</Label>
                <Input
                  autoComplete="username"
                  id="prompt-username"
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  value={username}
                />
              </div>
            )}
            <div>
              <Label className="block mb-1" htmlFor="prompt-password">
                Password
              </Label>
              <Input
                autoFocus
                id="prompt-password"
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                value={password}
              />
            </div>
            <Button
              className="w-full"
              disabled={isConnecting}
              type="submit"
            >
              {isConnecting && <Loader2 className="animate-spin" size={16} />}
              {isConnecting ? "Connecting..." : "Connect"}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

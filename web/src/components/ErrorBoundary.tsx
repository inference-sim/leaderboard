import { Component, type ReactNode } from 'react'

interface Props {
  /** When this value changes, a caught error is cleared so navigating away recovers. */
  resetKey?: unknown
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches a render error in the view below it and shows the message in place, rather than
 * letting an uncaught throw blank the whole app (React unmounts the entire root on an
 * uncaught error, and this app mounts no other boundary). The message is the reader's only
 * clue to what broke, so it is shown verbatim, not swallowed. Keyed by the current view in
 * App, so switching tabs clears a caught error and the app keeps working.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="viewerror" role="alert">
          <h2 className="viewhead">This view hit an error</h2>
          <p className="dek">
            Something on this page threw and could not render. The message below is the exact
            error; switch to another tab and back to retry, or reload the page.
          </p>
          <pre className="viewerror-msg">
            <code>{this.state.error.message || String(this.state.error)}</code>
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

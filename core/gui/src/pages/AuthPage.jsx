import { useState } from 'react';

function LoginForm({ onSubmit, pending, error, switchToRegister }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(identifier.trim(), password, remember);
      }}
    >
      <div>
        <label className="block text-left text-sm font-medium text-muted" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          type="text"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-border bg-surface/80 px-4 py-2 text-sm text-foreground placeholder:text-subtle focus:border-accent focus:outline-none focus:ring focus:ring-accent/30"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-muted" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-border bg-surface/80 px-4 py-2 text-sm text-foreground placeholder:text-subtle focus:border-accent focus:outline-none focus:ring focus:ring-accent/30"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-sm text-muted" htmlFor="remember">
          <input
            id="remember"
            type="checkbox"
            className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring focus:ring-accent/30 focus:outline-none"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={pending}
          />
          <span>Remember me</span>
        </label>
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-subtle"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-center text-sm text-subtle">
        Need an account?{' '}
        <button
          type="button"
          className="font-medium text-amber-400 transition hover:text-amber-300"
          onClick={switchToRegister}
          disabled={pending}
        >
          Register
        </button>
      </p>
    </form>
  );
}

function RegisterForm({ onSubmit, pending, error, switchToLogin }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(username.trim(), email.trim(), password);
      }}
    >
      <div>
        <label className="block text-left text-sm font-medium text-muted" htmlFor="reg-username">
          Username
        </label>
        <input
          id="reg-username"
          type="text"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-border bg-surface/80 px-4 py-2 text-sm text-foreground placeholder:text-subtle focus:border-accent focus:outline-none focus:ring focus:ring-accent/30"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-muted" htmlFor="reg-email">
          Email
        </label>
        <input
          id="reg-email"
          type="email"
          autoComplete="email"
          className="mt-1 w-full rounded-xl border border-border bg-surface/80 px-4 py-2 text-sm text-foreground placeholder:text-subtle focus:border-accent focus:outline-none focus:ring focus:ring-accent/30"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-muted" htmlFor="reg-password">
          Password
        </label>
        <input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          className="mt-1 w-full rounded-xl border border-border bg-surface/80 px-4 py-2 text-sm text-foreground placeholder:text-subtle focus:border-accent focus:outline-none focus:ring focus:ring-accent/30"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-success px-5 py-2 text-sm font-semibold text-success-foreground transition hover:bg-success/90 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-subtle"
      >
        {pending ? 'Creating account…' : 'Create account'}
      </button>
      <p className="text-center text-sm text-subtle">
        Already registered?{' '}
        <button
          type="button"
          className="font-medium text-amber-400 transition hover:text-amber-300"
          onClick={switchToLogin}
          disabled={pending}
        >
          Sign in
        </button>
      </p>
    </form>
  );
}

export default function AuthPage({ mode, setMode, pending, error, onLogin, onRegister, embedded = false }) {
  const content = (
    <div className="w-full max-w-md space-y-6 rounded-2xl border border-border/80 bg-surface/90 p-10 shadow-2xl">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold text-foreground">Publex</h1>
        <p className="text-sm text-subtle">
          {mode === 'login' ? 'Sign in to manage your transcoder.' : 'Create an account to manage your transcoder.'}
        </p>
      </div>
      {mode === 'login' ? (
        <LoginForm
          onSubmit={onLogin}
          pending={pending}
          error={error}
          switchToRegister={() => setMode('register')}
        />
      ) : (
        <RegisterForm
          onSubmit={onRegister}
          pending={pending}
          error={error}
          switchToLogin={() => setMode('login')}
        />
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      {content}
    </main>
  );
}

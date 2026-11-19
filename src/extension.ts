import { ExtensionContext } from "vscode";
import { registerLifecycleStudio } from "./lifecycle/studio";
import { registerOnboardingStudio } from "./onboarding/studio";

export function activate(context: ExtensionContext): void {
    registerLifecycleStudio(context);
    registerOnboardingStudio(context);
}

export function deactivate(): void {}

import AuraActiveEffectData from "./AuraActiveEffectData.mjs";
import AuraActiveEffectSheet from "./AuraActiveEffectSheet.mjs";
import { getNearbyTokens, getTokenToTokenDistance, isFinalMovementComplete } from "./helpers.mjs";
import { applyAuraEffects, applyEffect, deleteAuraEffects, deleteEffects } from "./queries.mjs";

// Track whether the "with no GM this no work" warning has been seen
let seenWarning = false;

/**
 * Provided the arguments for the updateToken hook, checks if any effects on the token are aura source effects
 * and, if so, removes/adds to nearby tokens as necessary. Also checks if moving should remove non-source aura
 * effects (or add them) and does so if necessary.
 * @param {TokenDocument} token     The token being updated
 * @param {Object} updates          The updates
 * @param {Object} options          Additional options
 * @param {string} userId           The initiating User's ID
 */
async function updateToken(token, updates, options, userId) {
    // Exit early for non-initiators, if no active GM, or if non-movement update
    if (game.user.id !== userId) return;
    const activeGM = game.users.activeGM;
    if (!activeGM) {
        if (!seenWarning) {
            ui.notifications.warn("AURAS.NoActiveGM", {localize: true});
            seenWarning = true;
        }
        return;
    }
    if (!token.actor) return;
    if (!updates.x && !updates.y && !updates.elevation) return;
    const allEffects = token.actor.appliedEffects;
    const sourceEffects = allEffects.filter(e => e.type === "auras.aura");
    
    // Get start-of-movement in-range tokens for each aura source effect
    const preMoveRanges = {};
    for (const effect of sourceEffects) {
        const { distance: radius, disposition, collisionTypes } = effect.system;
        if (!radius) continue;
        preMoveRanges[effect.uuid] = new Set(getNearbyTokens(token, radius, { disposition, collisionTypes }).map(t => t.actor));
    }
    await token.object.movementAnimationPromise;

    // Get end-of-movement in-range tokens for each aura source effect, removing effects which should be removed,
    // adding effects which should be added IF this is the final segment of movement
    for (const effect of sourceEffects) {
        const { distance: radius, disposition, collisionTypes } = effect.system;
        if (!radius) continue;
        const preMoveRange = preMoveRanges[effect.uuid];
        const effectData = foundry.utils.mergeObject(effect.toObject(), {
            origin: effect.uuid,
            type: effect.getFlag("auras", "originalType") ?? "base"
        });
        const postMoveRange = new Set(getNearbyTokens(token, radius, { disposition, collisionTypes }).map(t => t.actor))
        const toDelete = Array.from(preMoveRange.difference(postMoveRange)).map(a => a.effects.find(e => e.origin === effect.uuid)?.uuid);
        await activeGM.query("auras.deleteEffects", {effectUuids: toDelete})
        if (isFinalMovementComplete(token)) {
            const toAddTo = Array.from(postMoveRange.filter(a => (a !== token.actor) && !a?.effects.find(e => e.origin === effect.uuid))).map(a => a?.uuid);
            await activeGM.query("auras.applyEffect", {effectData, actorUuids: toAddTo});
        }
    }

    // Get all aura source effects on the scene, split into "actor shouldn't have" and "actor should have"
    const [sceneAurasToRemove, sceneAurasToAdd] = token.parent.tokens.reduce(([toRemove, toAdd], sourceToken) => {
        if (sourceToken.actor === token.actor) return [toRemove, toAdd];
        // -1 if enemies, 0 if at least one is neutral, 1 if allied
        // TODO: account for secret? (don't apply, presumably)
        const disposition = token.disposition * sourceToken.disposition;
        const auraEffects = sourceToken.actor.appliedEffects.filter(e => (e.type === "auras.aura") 
            && ((e.system.disposition === 0) || (e.system.disposition === disposition))
        );
        if (!auraEffects.length) return [toRemove, toAdd];

        for (const currEffect of auraEffects) {
            const distance = getTokenToTokenDistance(token, sourceToken, { collisionTypes: currEffect.system.collisionTypes });
            if (currEffect.system.distance < distance) toRemove.push(currEffect);
            else toAdd.push(currEffect);
        }

        // TODO: Can I do this clever thing and still handle the proper collision checks? 
        // Would prefer not to repeat distance checks unnecessarily
        // const distance = getTokenToTokenDistance(token, sourceToken);
        // toRemove.push(...auraEffects.filter(e => e.system.distance < distance));
        // toAdd.push(...auraEffects.filter(e => e.system.distance >= distance));
        return [toRemove, toAdd]
    }, [[], []]);

    // Remove effects actor shouldn't have, add effects actor should have (if final segment of token's movement)
    if (sceneAurasToRemove.length) await activeGM.query("auras.deleteAuraEffects", {
        [token.actor.uuid]: sceneAurasToRemove.map(e => e.uuid)
    });
    if (sceneAurasToAdd.length && isFinalMovementComplete(token)) await activeGM.query("auras.applyAuraEffects", {
        [token.actor.uuid]: sceneAurasToAdd.map(e => e.uuid)
    });
}

/**
 * Injects a checkbox to transform the effect into an "Aura Active Effect" when the AE Config sheet is rendered
 * @param {ActiveEffectConfig} app  The Active Effect Config sheet being rendered
 * @param {HTMLElement} html        The HTML Element
 */
function injectAuraCheckbox(app, html) {
    const element = new foundry.data.fields.BooleanField().toFormGroup({
        label: game.i18n.localize("AURAS.IsAura"),
        hint: game.i18n.localize("AURAS.IsAuraHint")
    }, {
        value: app.document.type === "auras.aura"
    });
    html.querySelector("[data-tab=details] > .form-group:last-of-type")?.after(element);
    element.addEventListener("change", () => {
        const currType = app.document.type;
        const updates = app._processFormData(null, app.form, new FormDataExtended(app.form));
        if (currType === "auras.aura") {
            updates.type = app.document.getFlag("auras", "originalType") ?? "base";
            foundry.utils.setProperty(updates, "flags.-=auras", null);
        } else {
            updates.type = "auras.aura";
            foundry.utils.setProperty(updates, "flags.auras.originalType", currType);
        }
        updates["==system"] = app.document.system;
        return app.document.update(updates);
    })
}

function registerHooks() {
    Hooks.on("updateToken", updateToken);
    Hooks.on("renderActiveEffectConfig", injectAuraCheckbox);
}

function registerQueries() {
    CONFIG.queries["auras.applyEffect"] = applyEffect;
    CONFIG.queries["auras.deleteEffects"] = deleteEffects;
    CONFIG.queries["auras.applyAuraEffects"] = applyAuraEffects;
    CONFIG.queries["auras.deleteAuraEffects"] = deleteAuraEffects;
}

function registerAuraType() {
    Object.assign(CONFIG.ActiveEffect.dataModels, {
        "auras.aura": AuraActiveEffectData
    });
    DocumentSheetConfig.registerSheet(ActiveEffect, "auras", AuraActiveEffectSheet, {
        types: ["auras.aura"],
        makeDefault: true
    });
}

Hooks.once("init", () => {
    registerHooks();
    registerQueries();
    registerAuraType();
});
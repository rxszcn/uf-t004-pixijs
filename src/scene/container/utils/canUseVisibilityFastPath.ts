import type { ViewContainer } from '../../view/ViewContainer';
import type { Container } from '../Container';

/**
 * Returns true when flipping the display status (visible / renderable / culled) of the given
 * container can be applied through the incremental "per-element alpha" fast path instead of a full
 * render group instruction rebuild.
 *
 * The fast path only supports subtrees whose renderable leaves are drawn exclusively through the
 * shared batcher (sprites, batchable graphics, meshes, ...). Any of the following forces a full
 * rebuild to keep the rendered pixels byte-identical with the legacy behaviour:
 *
 * - a nested render group, as it owns a separate instruction set and cannot be muted from the
 *   parent group's batcher;
 * - a render layer, whose render order is resolved outside the parent traversal;
 * - an effect (mask / filter) anywhere in the subtree, whose push/pop instructions and bounds
 *   (including nested mask and filter bounds) must be rebuilt to stay correct;
 * - a renderable drawn by a dedicated (non batchable) draw instruction, for example a large
 *   graphics context, text or mesh rendered directly rather than via the batcher.
 *
 * The walk is bounded by the toggled subtree, so its cost is proportional to the area that the
 * legacy full rebuild would otherwise have touched in full.
 * @param container - the container whose display status is about to flip
 * @internal
 */
export function canUseVisibilityFastPath(container: Container): boolean
{
    // a render group root is rendered through its own instruction set
    if (container.renderGroup) return false;

    return _subtreeSupportsVisibilityFastPath(container);
}

function _subtreeSupportsVisibilityFastPath(container: Container): boolean
{
    // masks / filters inject push/pop instructions and contribute their own bounds
    if (container.effects.length) return false;

    // render layers are collected from a separate location in the scene graph
    if (container.parentRenderLayer) return false;

    // a renderable that is not part of the shared batcher cannot be muted in place
    if (container.renderPipeId && !(container as ViewContainer).batched) return false;

    const children = container.children;

    for (let i = 0; i < children.length; i++)
    {
        const child = children[i];

        // nested render groups own their own instruction set / batcher
        if (child.renderGroup) return false;

        if (!_subtreeSupportsVisibilityFastPath(child)) return false;
    }

    return true;
}

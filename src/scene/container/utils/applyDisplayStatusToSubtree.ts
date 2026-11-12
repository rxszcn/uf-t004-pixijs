import type { BatchableElement } from '../../../rendering/batcher/shared/Batcher';
import type { ViewContainer } from '../../view/ViewContainer';
import type { Container } from '../Container';

/**
 * The subset of renderer owned GPU data that exposes the batchable elements created for a
 * renderable. The shapes differ between render pipes:
 *
 * - sprites store the batchable element directly;
 * - batchable graphics store an array of cloned batchable elements in `batches`;
 * - batched meshes store their single element in `batchableMesh`.
 */
type BatchableGPUData = BatchableElement & {
    batches?: BatchableElement[];
    batchableMesh?: BatchableElement;
};

/**
 * Recursively applies the current display status of a subtree to every batched renderable it
 * contains. This powers the incremental visibility fast path: hidden renderables have their batch
 * elements' alpha muted in place while visible ones are restored, and only the affected GPU bytes
 * are re-uploaded through the existing batcher update path.
 *
 * The subtree is known to be fast-path eligible (see {@link canUseVisibilityFastPath}), so every
 * renderable leaf is guaranteed to be part of the shared batcher and to expose its batchable
 * elements through renderer owned GPU data.
 * @param container - root of the subtree whose display status flipped
 * @internal
 */
export function applyDisplayStatusToSubtree(container: Container): void
{
    _apply(container);
}

function _apply(container: Container): void
{
    if (container.renderGroup) return;

    if (container.renderPipeId)
    {
        _applyToRenderable(container as ViewContainer);
    }

    const children = container.children;

    for (let i = 0; i < children.length; i++)
    {
        _apply(children[i]);
    }
}

function _applyToRenderable(renderable: ViewContainer): void
{
    const hidden = renderable.globalDisplayStatus < 0b111;
    const visibilityAlpha = hidden ? 0 : 1;

    const gpuData = renderable._gpuData as Record<number, BatchableGPUData>;

    for (const rendererUid in gpuData)
    {
        const data = gpuData[rendererUid];

        if (!data) continue;

        // sprites store their (quad) batchable element directly
        if (typeof data._batcher !== 'undefined' || data.batcherName)
        {
            _setVisibilityAlpha(data, visibilityAlpha);
        }

        // graphics style GPU data owns an array of cloned batchable elements
        if (data.batches)
        {
            const batches = data.batches;

            for (let i = 0; i < batches.length; i++)
            {
                _setVisibilityAlpha(batches[i], visibilityAlpha);
            }
        }

        // mesh GPU data owns a single batchable element when batched
        if (data.batchableMesh)
        {
            _setVisibilityAlpha(data.batchableMesh, visibilityAlpha);
        }
    }
}

/**
 * Mutes / restores a single batchable element and asks its batcher to repack just that element,
 * which marks the batcher dirty so the changed bytes are uploaded on the next upload phase.
 * @param element - the batchable element to update
 * @param visibilityAlpha - 0 to hide the element, 1 to restore it
 */
function _setVisibilityAlpha(element: BatchableElement, visibilityAlpha: number): void
{
    if (element.visibilityAlpha === visibilityAlpha) return;

    element.visibilityAlpha = visibilityAlpha;

    element._batcher?.updateElement(element);
}

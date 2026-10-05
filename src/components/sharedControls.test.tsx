// @vitest-environment jsdom
import { resetPopoverGuard } from '../lib/overlays/popoverGuard'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WheelPopover } from './WheelPicker'
import { Stepper } from './Stepper'
import { TimeField } from './TimeField'
import { Sheet } from '../lib/overlays/Sheet'

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({matches: false, media:q,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false}}))
  Element.prototype.scrollTo = () => {}
})
afterEach(() => { cleanup(); resetPopoverGuard(); vi.unstubAllGlobals() })
const anchor = {left: 100,top:100,bottom:140,right:300,width:200,height:40,x:100,y:100,toJSON:()=>({})} as DOMRect
it('invalid typed time stays open and can be corrected', () => {
  const onCommit=vi.fn()
  render(<WheelPopover anchor={anchor} initial={new Date(2026,9,2,10,30)} onClose={()=>{}} onCommit={onCommit} />)
  fireEvent.change(screen.getByRole('textbox'), {target:{value:'25:99'}})
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('25:99')
  fireEvent.click(screen.getByRole('button', {name:'OK'}))
  expect(onCommit).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('00:00')
  fireEvent.keyDown(screen.getByRole('textbox'), {key:'Enter'})
  expect(onCommit).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox'), {target:{value:'14:35'}})
  fireEvent.keyDown(screen.getByRole('textbox'), {key:'Enter'})
  expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({h:14,mi:35}))
})
it('stepper supports click-only and keyboard activation', () => {
  const onChange=vi.fn()
  render(<Stepper value={2} min={0} max={10} onChange={onChange} ariaLabel="Quantity" />)
  const plus=screen.getByText('+')
  fireEvent.click(plus)
  expect(onChange).toHaveBeenCalledWith(3)
  onChange.mockClear()
  fireEvent.keyDown(plus, {key:'Enter'})
  expect(onChange).toHaveBeenCalledWith(3)
})
it('Escape closes only the time picker and preserves the surrounding sheet', () => {
  const onClose=vi.fn()
  render(<Sheet open title="Parent" onClose={onClose}><TimeField value="10:30" onCommit={()=>{}} ariaLabel="Time" /></Sheet>)
  fireEvent.click(screen.getByRole('button', {name:'Time'}))
  expect(screen.getByRole('textbox')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('textbox'), {key:'Escape'})
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.queryByRole('textbox')).toBeNull()
})
it('optional time offers an explicit clear action', () => {
  const onCommit=vi.fn()
  render(<TimeField value="10:30" ariaLabel="Time" onCommit={onCommit} />)
  fireEvent.click(screen.getByRole('button', {name:'Time'}))
  fireEvent.click(screen.getByRole('button', {name:'Leeren'}))
  expect(onCommit).toHaveBeenCalledWith(null)
})
it('pointer tap steps exactly once despite its subsequent click', () => {
  const onChange=vi.fn()
  render(<Stepper value={2} min={0} max={10} onChange={onChange} ariaLabel="Quantity" />)
  const plus=screen.getByText('+')
  fireEvent.pointerDown(plus, {button:0})
  fireEvent.pointerUp(window)
  fireEvent.click(plus, {detail:1})
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith(3)
})

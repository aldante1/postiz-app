'use client';

import clsx from 'clsx';
import type { FC, ReactNode } from 'react';

const baseButtonClass =
  'select-none cursor-pointer rounded-[6px] w-[30px] h-[30px] bg-newColColor flex justify-center items-center';

export const FormatButton: FC<{
  active: boolean;
  children: ReactNode;
  onClick: () => void;
  tooltip: string;
}> = ({ active, children, onClick, tooltip }) => {
  return (
    <div
      data-tooltip-id="tooltip"
      data-tooltip-content={tooltip}
      onClick={onClick}
      className={clsx(
        baseButtonClass,
        active && 'ring-1 ring-white/40 text-white'
      )}
    >
      {children}
    </div>
  );
};

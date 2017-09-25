import React from 'react';
import ReactDOM from 'react-dom';
import styles from './styles.less';
import classNames from 'classnames';
import mapPropsStream from 'recompose/mapPropsStream';
import createEventHandler from 'recompose/createEventHandler';

import {
    Badge, Overlay,
    Button, Tooltip, OverlayTrigger,
    ButtonGroup, ButtonToolbar,
    ListGroup, ListGroupItem
} from 'react-bootstrap';

export function ButtonList({ children, visible, menu = true }) {

    if (!visible || !menu) {
        return null;
    }

    return (
        <ListGroup className={styles['button-list']}>
        {children.map((child) => [
            <ListGroupItem key={child.key} className={classNames({
                [styles[child.key]]: true,
                [styles['button-list-items-container']]: true
            })}>
                {child}
            </ListGroupItem>,
            ' '
        ])}
        </ListGroup>
    );
}

export function ButtonListItems({ id, name, children }) {
    return (
        <ButtonToolbar data-group-name={name}
                       className={classNames({
                           [styles[id]]: true,
                           [styles['button-list-items']]: true
                       })}>
            <ButtonGroup vertical={id === 'camera'}>
                {children}
            </ButtonGroup>
        </ButtonToolbar>
    );
}

function ButtonListItemTooltip(name) {
    return (
        <Tooltip id='button-list-item-tooltip'>{name}</Tooltip>
    );
}

export function ButtonListItem({ onItemSelected, renderPopover, popoverData, isPopoverOpen, groupId, badgeCount = 0, ...props }) {

    let overlayRef, buttonWithOverlay;
    const { id, name, type, selected } = props;
    const placement = (groupId === 'camera') ||
                      (window && window.innerWidth < 330) ? 'right' : 'bottom';

    if (type === undefined || !selected) {
        buttonWithOverlay = (
            <OverlayTrigger defaultOverlayShown={false}
                            trigger={['hover']} placement={placement}
                            overlay={ButtonListItemTooltip(name)}>
                <Button id={id}
                        active={selected}
                        onClick={(e) => e.preventDefault() || onItemSelected(props)}
                        className={classNames({
                             [styles[id]]: true,
                             // fa: true,
                             'fa-fw': true,
                             [styles['selected']]: selected,
                             [styles['button-list-item']]: true
                        })}>
                    {badgeCount && <Badge pullRight>{badgeCount}</Badge> || undefined}
                    <span className={styles['overlay-hit-area']} ref={(ref) => overlayRef = ref}/>
                </Button>
            </OverlayTrigger>
        );
    } else {
        buttonWithOverlay = (
            <Button id={id}
                    active={selected}
                    onClick={(e) => e.preventDefault() || onItemSelected(props)}
                    className={classNames({
                         [styles[id]]: true,
                         // fa: true,
                         'fa-fw': true,
                         [styles['selected']]: selected,
                         [styles['button-list-item']]: true
                    })}>
                {badgeCount && <Badge pullRight>{badgeCount}</Badge> || undefined}
                <span className={styles['overlay-hit-area']} ref={(ref) => overlayRef = ref}/>
                <Overlay show={selected}
                         rootClose={true}
                         animation={false}
                         placement={placement}
                         containerPadding={10}
                         shouldUpdatePosition={true}
                         onHide={() => onItemSelected(props)}
                         target={() => ReactDOM.findDOMNode(overlayRef)}>
                    {renderPopover({ data: popoverData, isOpen: isPopoverOpen })}
                </Overlay>
            </Button>
        );
    }

    return buttonWithOverlay;
}